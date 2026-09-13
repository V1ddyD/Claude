import Link from 'next/link';
import type { Route } from 'next';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withStaff } from '@/server/auth/require-staff';
import { getTenantById } from '@/server/context/tenant';
import { countByPriority, listLeads } from '@/server/db/repositories/leads';
import { listDueFollowUps } from '@/server/services/follow-ups';
import { appointments, leads, tickets } from '@/server/db/schema';
import { relativeTime } from '@/components/portal/relative-time';
import { PriorityBadge } from '@/components/portal/priority-badge';
import { completeFollowUpAction } from './leads/[id]/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

const SERVICE_TICKETS = ['service'] as const;
const SALES_TICKETS = [
  'sales_enquiry', 'test_drive', 'financing', 'trade_in', 'callback', 'general', 'support',
] as const;

/**
 * Where the day starts.
 *
 * Every signed-in member of staff may open this; what it shows is decided panel
 * by panel. A service advisor holds no lead permission, and requiring one here
 * meant they signed in successfully and were shown an error page — the one
 * screen everybody lands on was the one screen some of them could not see.
 *
 * Every figure on it is counted from the database. It used to carry three
 * panels reading "Connected in M6", which is a note from the people building
 * the software to themselves; a dealership reading it learns only that part of
 * their portal does not work.
 */
export default async function DashboardPage() {
  const { leadWork, diary, openTickets, staff } = await withStaff(async (db, currentStaff) => {
    const seesLeads = currentStaff.can('lead.read.assigned');
    const { timezone } = await getTenantById(currentStaff.tenantId);

    const ticketTypes = [
      ...(currentStaff.can('ticket.sales.read') ? SALES_TICKETS : []),
      ...(currentStaff.can('ticket.service.read') ? SERVICE_TICKETS : []),
    ];

    const [leadWork, diary, openTickets] = await Promise.all([
      seesLeads
        ? (async () => ({
            counts: await countByPriority(db, currentStaff),
            followUps: await listDueFollowUps(
              db,
              currentStaff.authUserId,
              currentStaff.can('lead.read.all'),
            ),
            // The few worth acting on now, so the page answers "who do I call
            // next" rather than only "how many are there".
            attention: (await listLeads(db, currentStaff, 20))
              .filter(
                (lead) =>
                  lead.priority !== 'low' &&
                  ['new', 'contacted', 'qualified'].includes(lead.status),
              )
              .slice(0, 5),
            unassigned: await db
              .select({ count: sql<number>`count(*)::int` })
              .from(leads)
              .where(
                and(
                  eq(leads.tenantId, db.tenantId),
                  isNull(leads.assignedStaffId),
                  inArray(leads.status, ['new', 'contacted', 'qualified']),
                ),
              )
              .then((r) => r[0]?.count ?? 0),
          }))()
        : null,

      // "Today" in the dealership's own timezone, which is the only one that
      // means anything to the person reading this page.
      currentStaff.can('appointment.read')
        ? db
            .select({ count: sql<number>`count(*)::int` })
            .from(appointments)
            .where(
              and(
                eq(appointments.tenantId, db.tenantId),
                inArray(appointments.status, ['scheduled', 'confirmed']),
                sql`(${appointments.startsAt} AT TIME ZONE ${timezone})::date
                    = (now() AT TIME ZONE ${timezone})::date`,
              ),
            )
            .then((r) => r[0]?.count ?? 0)
        : null,

      ticketTypes.length > 0
        ? db
            .select({ count: sql<number>`count(*)::int` })
            .from(tickets)
            .where(
              and(
                eq(tickets.tenantId, db.tenantId),
                inArray(tickets.status, ['open', 'in_progress']),
                inArray(tickets.type, [...ticketTypes]),
              ),
            )
            .then((r) => r[0]?.count ?? 0)
        : null,
    ]);

    return {
      leadWork,
      diary,
      openTickets,
      staff: {
        fullName: currentStaff.fullName,
        seesAll: currentStaff.can('lead.read.all'),
      },
    };
  });

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-medium tracking-tight text-ink-900">
          {greeting()}, {staff.fullName.split(' ')[0]}
        </h1>
        <p className="text-sm text-ink-500">
          {leadWork ? (staff.seesAll ? 'All dealership leads' : 'Your assigned leads') : 'Service desk'}
        </p>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {leadWork && (
          <>
            <Figure
              href="/portal/leads"
              label="High priority"
              value={leadWork.counts.high}
              note="Open leads needing a call"
              tone="high"
            />
            <Figure
              href="/portal/leads"
              label="Medium priority"
              value={leadWork.counts.medium}
              note="Worth following up"
            />
            <Figure
              href="/portal/leads"
              label="Unassigned"
              value={leadWork.unassigned}
              note="Nobody has picked these up"
              tone={leadWork.unassigned > 0 ? 'high' : 'plain'}
            />
          </>
        )}

        {diary !== null && (
          <Figure
            href="/portal/appointments"
            label="Today's appointments"
            value={diary}
            note={diary === 1 ? 'Booked for today' : 'Booked for today'}
          />
        )}

        {openTickets !== null && (
          <Figure
            href="/portal/tickets"
            label="Open tickets"
            value={openTickets}
            note="Waiting on someone here"
          />
        )}

        {leadWork && (
          <Figure
            href="/portal/leads"
            label="Low priority"
            value={leadWork.counts.low}
            note="Nurture"
          />
        )}
      </div>

      {!leadWork && (
        <p className="mt-8 max-w-2xl text-sm leading-relaxed text-ink-500">
          Sales leads are not part of your role. The service diary, service tickets and the
          vehicle records are in the menu above.
        </p>
      )}

      {leadWork && leadWork.attention.length > 0 && (
        <section className="mt-12">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">
              Worth a call now
            </h2>
            <Link
              href="/portal/leads"
              className="text-xs text-ink-500 underline-offset-2 hover:text-ink-900 hover:underline"
            >
              All leads
            </Link>
          </div>

          <ul className="mt-4 divide-y divide-ink-100 overflow-hidden rounded border border-ink-100 bg-white">
            {leadWork.attention.map((lead) => (
              <li key={lead.id} className="relative transition-colors hover:bg-ink-50">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="w-16 shrink-0">
                    <PriorityBadge priority={lead.priority} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/portal/leads/${lead.id}`}
                      className="text-sm text-ink-900 before:absolute before:inset-0 before:content-[''] hover:underline"
                    >
                      {lead.customerName ?? 'Unnamed customer'}
                    </Link>
                    <p className="truncate text-xs text-ink-500">
                      {lead.wants ? `Wants the ${lead.wants}` : 'Nothing specific yet'}
                      {!lead.assignedTo && ' · unassigned'}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs text-ink-500">
                    {relativeTime(lead.lastActivityAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {leadWork && (
        <section className="mt-12">
          <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">Follow-ups due</h2>

          {leadWork.followUps.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">
              Nothing outstanding. Tasks appear here when a high-priority lead goes unanswered, a
              callback is waiting, or a test drive is tomorrow.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-ink-100 overflow-hidden rounded border border-ink-100 bg-white">
              {leadWork.followUps.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    {/* The action first: staff need to know what to DO, not
                        which rule fired. */}
                    <p className="text-sm text-ink-900">{task.recommendedAction}</p>
                    <p className="text-xs text-ink-500">
                      {task.reason} · due {relativeTime(task.dueAt)}
                    </p>
                  </div>
                  {task.leadId && (
                    <Link
                      href={`/portal/leads/${task.leadId}`}
                      className="text-sm text-ink-900 underline-offset-2 hover:underline"
                    >
                      Open
                    </Link>
                  )}
                  <form action={completeFollowUpAction} className="flex gap-2">
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="leadId" value={task.leadId ?? ''} />
                    <button
                      type="submit"
                      name="outcome"
                      value="done"
                      className="rounded bg-ink-900 px-2.5 py-1 text-xs text-white hover:bg-ink-800"
                    >
                      Done
                    </button>
                    <button
                      type="submit"
                      name="outcome"
                      value="dismissed"
                      className="rounded border border-ink-100 px-2.5 py-1 text-xs text-ink-500 hover:border-ink-300"
                    >
                      Dismiss
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function greeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function Figure({
  href,
  label,
  value,
  note,
  tone = 'plain',
}: {
  // Typed routes are on, so a mistyped path is a compile error rather than a
  // dead panel somebody finds in front of a customer.
  href: Route;
  label: string;
  value: number;
  note: string;
  tone?: 'plain' | 'high';
}) {
  return (
    <Link
      href={href}
      className="rounded border border-ink-100 bg-white p-5 transition-colors hover:border-ink-300"
    >
      <p className="text-xs uppercase tracking-wider text-ink-500">{label}</p>
      <p
        className={`mt-3 text-3xl font-medium tabular-nums ${
          tone === 'high' && value > 0
            ? 'text-[color:var(--color-signal-high)]'
            : value === 0
              ? 'text-ink-300'
              : 'text-ink-900'
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-ink-500">{note}</p>
    </Link>
  );
}
