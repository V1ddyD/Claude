import { requireStaff } from '@/server/auth/require-staff';

export const metadata = { title: 'Dashboard' };

/**
 * Dashboard shell.
 *
 * Empty by design at M1: the panels below are the ones spec §23 calls for, and
 * each is filled in when the subsystem behind it actually exists. Rendering
 * fabricated counts now would make the portal look finished while telling
 * staff nothing true.
 */
const PANELS = [
  { title: 'New leads', arrives: 'M3' },
  { title: 'High priority', arrives: 'M3' },
  { title: 'Unassigned', arrives: 'M3' },
  { title: "Today's appointments", arrives: 'M4' },
  { title: 'Open tickets', arrives: 'M4' },
  { title: 'Follow-ups due', arrives: 'M5' },
];

export default async function DashboardPage() {
  const staff = await requireStaff('customer.read');

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-medium tracking-tight text-ink-900">
          Good afternoon, {staff.fullName.split(' ')[0]}
        </h1>
        <p className="text-sm text-ink-500">
          {staff.can('lead.read.all') ? 'All dealership leads' : 'Your assigned leads'}
        </p>
      </div>

      <div className="mt-8 grid gap-px overflow-hidden rounded border border-ink-100 bg-ink-100 sm:grid-cols-2 lg:grid-cols-3">
        {PANELS.map((panel) => (
          <div key={panel.title} className="bg-white p-5">
            <p className="text-xs uppercase tracking-wider text-ink-500">{panel.title}</p>
            <p className="mt-3 text-2xl font-medium tabular-nums text-ink-300">—</p>
            <p className="mt-1 text-xs text-ink-500">Connected in {panel.arrives}</p>
          </div>
        ))}
      </div>

      <p className="mt-8 max-w-2xl text-sm leading-relaxed text-ink-500">
        The foundation is complete: the schema is applied, tenant isolation is enforced by
        the database and verified by a non-skippable test suite, authorization is
        permission-based, and every change is audited. These panels stay empty until the
        subsystems behind them are real.
      </p>
    </>
  );
}
