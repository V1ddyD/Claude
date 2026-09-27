import { notFound } from 'next/navigation';
import { requireStaff, withStaff } from '@/server/auth/require-staff';
import { loadTeam, PLAN_LABEL } from '@/server/services/team';
import { getTenantById } from '@/server/context/tenant';
import { AddMember, MemberCard } from './team-manager';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Team' };

/**
 * The business's own staff: who can sign in, as what, and room for how many
 * more. Only people who may manage staff reach this page; everything it offers
 * is checked again on the server when used.
 */
export default async function TeamPage() {
  // Not found, rather than forbidden, for staff who cannot manage the team:
  // the page is not theirs to know about. withStaff below checks again.
  if (!(await requireStaff()).can('staff.manage')) notFound();

  const { team, tenantId } = await withStaff('staff.manage', async (db, staff) => ({
    team: await loadTeam(db, staff),
    tenantId: staff.tenantId,
  }));
  const tenant = await getTenantById(tenantId);
  const when = new Intl.DateTimeFormat(tenant.locale, {
    timeZone: tenant.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const unlimited = !Number.isFinite(team.seats);

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-medium tracking-tight text-ink-900">Team</h1>
        <p className="text-sm text-ink-500">
          {PLAN_LABEL[team.plan]} package · {team.used}
          {unlimited ? ' staff accounts' : ` of ${team.seats} staff accounts used`}
        </p>
      </div>

      <div className="mt-6">
        <AddMember assignable={team.assignable} full={!unlimited && team.used >= team.seats} />
      </div>

      <ul className="mt-8 divide-y divide-ink-100 rounded border border-ink-100 bg-white">
        {team.members.map((member) => (
          <MemberCard
            key={member.id}
            assignable={team.assignable}
            member={{
              id: member.id,
              fullName: member.fullName,
              email: member.email,
              role: member.role,
              isYou: member.isYou,
              manageable: member.manageable,
              lastSignIn: member.lastSignIn ? when.format(member.lastSignIn) : null,
            }}
          />
        ))}
      </ul>
      <p className="mt-4 text-xs text-ink-500">
        Removing someone signs them out everywhere straight away, and their open leads return to the unassigned list.
      </p>
    </div>
  );
}
