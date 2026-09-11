import Link from 'next/link';
import { withStaff } from '@/server/auth/require-staff';
import { countByPriority } from '@/server/db/repositories/leads';
import { listDueFollowUps } from '@/server/services/follow-ups';
import { completeFollowUpAction } from './leads/[id]/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

/**
 * Dashboard shell.
 *
 * Empty by design at M1: the panels below are the ones spec §23 calls for, and
 * each is filled in when the subsystem behind it actually exists. Rendering
 * fabricated counts now would make the portal look finished while telling
 * staff nothing true.
 */
const PENDING = [
  { title: "Today's appointments", arrives: 'M6' },
  { title: 'Open tickets', arrives: 'M6' },
  { title: 'Conversion', arrives: 'M6' },
];

export default async function DashboardPage() {
  const { counts, followUps, staff } = await withStaff(
    'lead.read.assigned',
    async (db, currentStaff) => ({
      counts: await countByPriority(db, currentStaff),
      followUps: await listDueFollowUps(
        db,
        currentStaff.authUserId,
        currentStaff.can('lead.read.all'),
      ),
      staff: {
        fullName: currentStaff.fullName,
        seesAll: currentStaff.can('lead.read.all'),
      },
    }),
  );

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-medium tracking-tight text-ink-900">
          Good afternoon, {staff.fullName.split(' ')[0]}
        </h1>
        <p className="text-sm text-ink-500">
          {staff.seesAll ? 'All dealership leads' : 'Your assigned leads'}
        </p>
      </div>

      <div className="mt-8 grid gap-px overflow-hidden rounded border border-ink-100 bg-ink-100 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/portal/leads" className="bg-white p-5 transition-colors hover:bg-ink-50">
          <p className="text-xs uppercase tracking-wider text-ink-500">High priority</p>
          <p className="mt-3 text-2xl font-medium tabular-nums text-[color:var(--color-signal-high)]">
            {counts.high}
          </p>
          <p className="mt-1 text-xs text-ink-500">Open leads needing a call</p>
        </Link>
        <Link href="/portal/leads" className="bg-white p-5 transition-colors hover:bg-ink-50">
          <p className="text-xs uppercase tracking-wider text-ink-500">Medium priority</p>
          <p className="mt-3 text-2xl font-medium tabular-nums text-ink-900">{counts.medium}</p>
          <p className="mt-1 text-xs text-ink-500">Worth following up</p>
        </Link>
        <Link href="/portal/leads" className="bg-white p-5 transition-colors hover:bg-ink-50">
          <p className="text-xs uppercase tracking-wider text-ink-500">Low priority</p>
          <p className="mt-3 text-2xl font-medium tabular-nums text-ink-500">{counts.low}</p>
          <p className="mt-1 text-xs text-ink-500">Nurture</p>
        </Link>

        {PENDING.map((panel) => (
          <div key={panel.title} className="bg-white p-5">
            <p className="text-xs uppercase tracking-wider text-ink-500">{panel.title}</p>
            <p className="mt-3 text-2xl font-medium tabular-nums text-ink-300">—</p>
            <p className="mt-1 text-xs text-ink-500">Connected in {panel.arrives}</p>
          </div>
        ))}
      </div>

      <section className="mt-12">
        <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">
          Follow-ups due
        </h2>

        {followUps.length === 0 ? (
          <p className="mt-4 text-sm text-ink-500">
            Nothing outstanding. Tasks appear here when a high-priority lead goes
            unanswered, a callback is waiting, or a test drive is tomorrow.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-ink-100 overflow-hidden rounded border border-ink-100 bg-white">
            {followUps.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  {/* The action first: staff need to know what to DO, not
                      which rule fired. */}
                  <p className="text-sm text-ink-900">{task.recommendedAction}</p>
                  <p className="text-xs text-ink-500">
                    {task.reason} · due{' '}
                    {new Intl.DateTimeFormat('en-CA', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(task.dueAt)}
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

      <p className="mt-10 max-w-2xl text-sm leading-relaxed text-ink-500">
        Lead figures and follow-ups are live. The remaining panels stay empty until the
        subsystems behind them exist — a fabricated count would make this page look
        finished while telling you nothing true.
      </p>
    </>
  );
}
