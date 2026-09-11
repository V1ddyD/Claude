import 'server-only';
import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import {
  appointments, appointmentResources, resources, businessHours, businessClosures,
  tickets, emailMessages, notifications, inventoryUnits, modelConfigurations,
  vehicleModels, customers,
} from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';
import { AppError, pgErrorCode, PG_EXCLUSION_VIOLATION, notFound } from '@/server/errors';
import { recordAudit } from '@/server/services/audit';
import { allocateTicketNumber } from '@/server/services/tickets/numbering';
import { upsertLead, recordLeadEvent, recomputePriority, applySignals } from '@/server/services/leads';
import { computeAvailableSlots, formatSlot, type Slot } from './availability';

/**
 * Test drive booking.
 *
 * The whole booking is ONE transaction: lead, appointment, resource holds,
 * ticket, queued email, staff notification and audit either all commit or none
 * do. A confirmation number the customer can quote must never exist without the
 * appointment behind it.
 */

export interface BookingSettings {
  slotMinutes: number;
  minNoticeHours: number;
  maxHorizonDays: number;
}

export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  slotMinutes: 60,
  minNoticeHours: 2,
  maxHorizonDays: 14,
};

export interface TenantTiming {
  timezone: string;
  locale: string;
  ticketPrefix: string;
  settings?: Partial<BookingSettings>;
}

/**
 * Offer bookable times.
 *
 * A test drive needs a salesperson AND a demonstrator, so a slot is only
 * offered when at least one of each is free. Offering a time the dealership
 * cannot actually staff is worse than offering fewer times.
 */
export async function getAvailableTestDriveSlots(
  db: TenantDb,
  tenant: TenantTiming,
  params: { from: Date; to: Date; now?: Date; modelSlug?: string },
): Promise<Slot[]> {
  const settings = { ...DEFAULT_BOOKING_SETTINGS, ...tenant.settings };
  const now = params.now ?? new Date();

  const [hours, closures, eligible] = await Promise.all([
    db
      .select({
        dayOfWeek: businessHours.dayOfWeek,
        opensAt: businessHours.opensAt,
        closesAt: businessHours.closesAt,
      })
      .from(businessHours)
      .where(and(eq(businessHours.tenantId, db.tenantId), eq(businessHours.department, 'sales'))),
    db
      .select({ startsOn: businessClosures.startsOn, endsOn: businessClosures.endsOn })
      .from(businessClosures)
      .where(eq(businessClosures.tenantId, db.tenantId)),
    findEligibleResources(db, params.modelSlug),
  ]);

  if (eligible.staff.length === 0 || eligible.vehicles.length === 0) return [];

  const bookings = await loadBookings(db, [...eligible.staff, ...eligible.vehicles], params.from, params.to);

  // A slot survives only if some salesperson and some demonstrator are both
  // free for it, which is why availability is computed per resource and then
  // intersected rather than computed once over "the dealership".
  const staffSlots = freeSlotsFor(eligible.staff, bookings, { hours, closures, settings, tenant, params, now });
  const vehicleSlots = freeSlotsFor(eligible.vehicles, bookings, { hours, closures, settings, tenant, params, now });

  const vehicleStarts = new Set(vehicleSlots.map((s) => s.startsAt.getTime()));
  return staffSlots.filter((s) => vehicleStarts.has(s.startsAt.getTime()));
}

function freeSlotsFor(
  resourceIds: string[],
  bookings: Map<string, { startsAt: Date; endsAt: Date }[]>,
  ctx: {
    hours: { dayOfWeek: number; opensAt: string; closesAt: string }[];
    closures: { startsOn: string; endsOn: string }[];
    settings: BookingSettings;
    tenant: TenantTiming;
    params: { from: Date; to: Date };
    now: Date;
  },
): Slot[] {
  const byStart = new Map<number, Slot>();

  for (const resourceId of resourceIds) {
    const slots = computeAvailableSlots({
      from: ctx.params.from,
      to: ctx.params.to,
      now: ctx.now,
      timezone: ctx.tenant.timezone,
      slotMinutes: ctx.settings.slotMinutes,
      minNoticeHours: ctx.settings.minNoticeHours,
      maxHorizonDays: ctx.settings.maxHorizonDays,
      hours: ctx.hours,
      closures: ctx.closures,
      bookings: bookings.get(resourceId) ?? [],
    });
    for (const slot of slots) byStart.set(slot.startsAt.getTime(), slot);
  }

  return [...byStart.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

async function findEligibleResources(db: TenantDb, modelSlug?: string) {
  const staff = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.tenantId, db.tenantId), eq(resources.kind, 'staff'), eq(resources.isActive, true)));

  const vehicleQuery = db
    .select({ id: resources.id })
    .from(resources)
    .innerJoin(inventoryUnits, eq(inventoryUnits.id, resources.inventoryUnitId))
    .innerJoin(modelConfigurations, eq(modelConfigurations.id, inventoryUnits.modelConfigurationId))
    .innerJoin(vehicleModels, eq(vehicleModels.id, modelConfigurations.modelId));

  const conditions = [
    eq(resources.tenantId, db.tenantId),
    eq(resources.kind, 'vehicle'),
    eq(resources.isActive, true),
    eq(inventoryUnits.isDemoVehicle, true),
    // A car that has been sold is not a demonstrator any more.
    inArray(inventoryUnits.status, ['available', 'service_hold']),
  ];
  if (modelSlug) conditions.push(eq(vehicleModels.slug, modelSlug));

  const vehicles = await vehicleQuery.where(and(...conditions));

  return { staff: staff.map((s) => s.id), vehicles: vehicles.map((v) => v.id) };
}

async function loadBookings(db: TenantDb, resourceIds: string[], from: Date, to: Date) {
  if (resourceIds.length === 0) return new Map();

  const rows = await db
    .select({
      resourceId: appointmentResources.resourceId,
      startsAt: appointmentResources.startsAt,
      endsAt: appointmentResources.endsAt,
    })
    .from(appointmentResources)
    .where(
      and(
        eq(appointmentResources.tenantId, db.tenantId),
        eq(appointmentResources.status, 'active'),
        inArray(appointmentResources.resourceId, resourceIds),
        gte(appointmentResources.endsAt, from),
        lte(appointmentResources.startsAt, to),
      ),
    );

  const map = new Map<string, { startsAt: Date; endsAt: Date }[]>();
  for (const row of rows) {
    const list = map.get(row.resourceId) ?? [];
    list.push({ startsAt: row.startsAt, endsAt: row.endsAt });
    map.set(row.resourceId, list);
  }
  return map;
}

export interface CreateTestDriveRequest {
  conversationId: string;
  customerId: string;
  startsAt: Date;
  modelSlug?: string;
  customerNotes?: string;
}

export interface TestDriveResult {
  appointmentId: string;
  confirmationCode: string;
  ticketNumber: string;
  startsAt: Date;
  endsAt: Date;
  formattedWhen: string;
  vehicle: string;
  /** Queued, not sent. The worker and the provider decide whether it is sent. */
  confirmationEmailQueued: boolean;
}

export async function createTestDrive(
  db: TenantDb,
  tenant: TenantTiming,
  request: CreateTestDriveRequest,
): Promise<TestDriveResult> {
  const settings = { ...DEFAULT_BOOKING_SETTINGS, ...tenant.settings };
  const endsAt = new Date(request.startsAt.getTime() + settings.slotMinutes * 60_000);

  const eligible = await findEligibleResources(db, request.modelSlug);
  if (eligible.staff.length === 0 || eligible.vehicles.length === 0) {
    throw new AppError('CONFLICT', 'No test drive vehicle is available for that model.');
  }

  const bookings = await loadBookings(
    db,
    [...eligible.staff, ...eligible.vehicles],
    new Date(request.startsAt.getTime() - 24 * 3600_000),
    new Date(endsAt.getTime() + 24 * 3600_000),
  );

  const freeStaff = eligible.staff.find((id) => !clashes(bookings.get(id), request.startsAt, endsAt));
  const freeVehicle = eligible.vehicles.find((id) => !clashes(bookings.get(id), request.startsAt, endsAt));

  if (!freeStaff || !freeVehicle) throw slotTaken();

  const customer = await db
    .select({ id: customers.id, fullName: customers.fullName, email: customers.email, consent: customers.contactConsent })
    .from(customers)
    .where(and(eq(customers.tenantId, db.tenantId), eq(customers.id, request.customerId)))
    .limit(1);
  if (!customer[0]) throw notFound('That customer');

  const leadId = await upsertLead(db, {
    conversationId: request.conversationId,
    customerId: request.customerId,
  });

  const confirmationCode = generateConfirmationCode();
  const created = await db
    .insert(appointments)
    .values({
      tenantId: db.tenantId,
      type: 'test_drive',
      customerId: request.customerId,
      leadId,
      startsAt: request.startsAt,
      endsAt,
      confirmationCode,
      customerNotes: request.customerNotes ?? null,
      createdByType: 'ai',
    })
    .returning({ id: appointments.id });

  const appointmentId = created[0]!.id;

  // The exclusion constraint fires HERE if anyone booked these resources in the
  // gap between the check above and this insert. That race is real, it is not
  // preventable by checking harder, and Postgres is what actually settles it.
  try {
    await db.insert(appointmentResources).values(
      [freeStaff, freeVehicle].map((resourceId) => ({
        tenantId: db.tenantId,
        appointmentId,
        resourceId,
        startsAt: request.startsAt,
        endsAt,
      })),
    );
  } catch (err) {
    if (pgErrorCode(err) === PG_EXCLUSION_VIOLATION) throw slotTaken();
    throw err;
  }

  const vehicleLabel = await describeVehicle(db, freeVehicle);
  const ticketNumber = await allocateTicketNumber(db, { prefix: tenant.ticketPrefix });

  await db.insert(tickets).values({
    tenantId: db.tenantId,
    number: ticketNumber,
    type: 'test_drive',
    subject: `Test drive — ${vehicleLabel}`,
    body: request.customerNotes ?? null,
    customerId: request.customerId,
    leadId,
    appointmentId,
    createdByType: 'ai',
  });

  const formattedWhen = formatSlot({ startsAt: request.startsAt, endsAt }, tenant.timezone, tenant.locale);

  // Queued in this transaction, so a rolled-back booking cannot send mail. The
  // customer is told it is on its way, never that it has been delivered.
  let emailQueued = false;
  if (customer[0].email && customer[0].consent) {
    await db.insert(emailMessages).values({
      tenantId: db.tenantId,
      templateKey: 'test_drive_confirmation',
      toEmail: customer[0].email,
      toName: customer[0].fullName,
      subject: `Your test drive is booked — ${ticketNumber}`,
      payload: {
        ticketNumber, confirmationCode, vehicle: vehicleLabel, when: formattedWhen,
      },
      dedupeKey: `test_drive:${appointmentId}`,
    });
    emailQueued = true;
  }

  await db.insert(notifications).values({
    tenantId: db.tenantId,
    roleTarget: 'sales',
    type: 'test_drive_booked',
    title: `Test drive booked — ${vehicleLabel}`,
    body: `${customer[0].fullName ?? 'A customer'} · ${formattedWhen} · ${ticketNumber}`,
    linkPath: `/portal/leads/${leadId}`,
  });

  await recordLeadEvent(db, leadId, {
    type: 'appointment_created',
    actorType: 'ai',
    summary: `Test drive booked for ${formattedWhen} (${ticketNumber}).`,
    payload: { appointmentId, ticketNumber },
  });

  await db
    .update(appointments)
    .set({ status: 'scheduled' })
    .where(and(eq(appointments.tenantId, db.tenantId), eq(appointments.id, appointmentId)));

  await recordAudit(db, {
    actor: { type: 'ai' },
    action: 'appointment.created',
    entityType: 'appointment',
    entityId: appointmentId,
    after: { startsAt: request.startsAt.toISOString(), ticketNumber, leadId },
  });

  // A committed booking is stronger evidence than anything extracted from
  // conversation: the system watched it happen. Recorded at full confidence
  // with source 'form', so the scorer does not discount it as a model guess.
  await applySignals(
    db,
    leadId,
    {
      testDriveRequested: { value: true, confidence: 1 },
      testDriveDate: { value: request.startsAt.toISOString().slice(0, 10), confidence: 1 },
    },
    { source: 'form' },
  );
  await recomputePriority(db, leadId);

  return {
    appointmentId,
    confirmationCode,
    ticketNumber,
    startsAt: request.startsAt,
    endsAt,
    formattedWhen,
    vehicle: vehicleLabel,
    confirmationEmailQueued: emailQueued,
  };
}

function clashes(
  bookings: { startsAt: Date; endsAt: Date }[] | undefined,
  startsAt: Date,
  endsAt: Date,
): boolean {
  return (bookings ?? []).some((b) => startsAt < b.endsAt && endsAt > b.startsAt);
}

function slotTaken(): AppError {
  return new AppError('SLOT_TAKEN', 'That time has just been taken. Here are the nearest alternatives.');
}

async function describeVehicle(db: TenantDb, resourceId: string): Promise<string> {
  const rows = await db
    .select({ name: resources.name })
    .from(resources)
    .where(and(eq(resources.tenantId, db.tenantId), eq(resources.id, resourceId)))
    .limit(1);
  return rows[0]?.name ?? 'Test drive vehicle';
}

/** Short, unambiguous, no vowels: a code read aloud over the phone. */
function generateConfirmationCode(): string {
  const alphabet = '23456789BCDFGHJKLMNPQRSTVWXZ';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export { computeAvailableSlots, formatSlot };
export type { Slot };
