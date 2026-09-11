import Link from 'next/link';
import { and, eq, gte, inArray, asc } from 'drizzle-orm';
import { withStaff } from '@/server/auth/require-staff';
import { appointments, customers } from '@/server/db/schema';
import { getTenantById } from '@/server/context/tenant';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Appointments' };

/**
 * The diary.
 *
 * Times are rendered in the dealership's own timezone, which is the only
 * timezone that means anything to the person reading this page.
 */
export default async function AppointmentsPage() {
  const { rows, tenantId } = await withStaff('appointment.read', async (db, staff) => ({
    tenantId: staff.tenantId,
    rows: await db
      .select({
        id: appointments.id,
        type: appointments.type,
        status: appointments.status,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        confirmationCode: appointments.confirmationCode,
        leadId: appointments.leadId,
        customerName: customers.fullName,
        customerPhone: customers.phone,
      })
      .from(appointments)
      .innerJoin(customers, eq(customers.id, appointments.customerId))
      .where(
        and(
          eq(appointments.tenantId, db.tenantId),
          inArray(appointments.status, ['scheduled', 'confirmed']),
          gte(appointments.endsAt, new Date()),
        ),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(100),
  }));

  const tenant = await getTenantById(tenantId);

  const byDay = rows.reduce<Record<string, typeof rows>>((groups, appointment) => {
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: tenant.timezone,
      dateStyle: 'full',
    }).format(appointment.startsAt);
    (groups[day] ??= []).push(appointment);
    return groups;
  }, {});

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-medium tracking-tight text-ink-900">Appointments</h1>
        <p className="text-sm text-ink-500">
          {rows.length} upcoming · {tenant.timezone.replace('_', ' ')}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-10 text-sm text-ink-500">
          Nothing booked. Test drives appear here as soon as a customer books one.
        </p>
      ) : (
        <div className="mt-8 space-y-8">
          {Object.entries(byDay).map(([day, group]) => (
            <section key={day}>
              <h2 className="text-[11px] uppercase tracking-[0.2em] text-ink-500">{day}</h2>
              <ul className="mt-3 divide-y divide-ink-100 overflow-hidden rounded border border-ink-100 bg-white">
                {group.map((appointment) => (
                  <li key={appointment.id} className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-4 py-3">
                    <span className="w-20 shrink-0 tabular-nums text-ink-900">
                      {new Intl.DateTimeFormat('en-CA', {
                        timeZone: tenant.timezone,
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      }).format(appointment.startsAt)}
                    </span>
                    <span className="min-w-0 flex-1">
                      {appointment.leadId ? (
                        <Link
                          href={`/portal/leads/${appointment.leadId}`}
                          className="text-ink-900 underline-offset-2 hover:underline"
                        >
                          {appointment.customerName ?? 'Unnamed'}
                        </Link>
                      ) : (
                        <span className="text-ink-900">{appointment.customerName ?? 'Unnamed'}</span>
                      )}
                      <span className="block text-xs text-ink-500">
                        {appointment.type.replace(/_/g, ' ')} · {appointment.confirmationCode}
                        {appointment.customerPhone ? ` · ${appointment.customerPhone}` : ''}
                      </span>
                    </span>
                    <span className="text-xs uppercase tracking-wider text-ink-500">
                      {appointment.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
