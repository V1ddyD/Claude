import Link from 'next/link';
import { withStaff } from '@/server/auth/require-staff';
import { listLeads } from '@/server/db/repositories/leads';
import { PriorityBadge } from '@/components/portal/priority-badge';
import { Tag } from '@/components/portal/tag';
import { relativeTime } from '@/components/portal/relative-time';
import { formatMoney } from '@/server/services/pricing';
import { getTenantById } from '@/server/context/tenant';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Leads' };

/**
 * The work queue.
 *
 * Ordered the way it should be worked — highest priority, then most recently
 * active — and written to be scanned rather than read. A salesperson opening
 * this wants three things per row before they decide whether to pick up the
 * phone: how urgent, what the customer wants, and how long they have been
 * waiting. Everything else is on the lead itself.
 */
const TIMEFRAMES: Record<string, string> = {
  immediate: 'Buying now',
  within_30_days: 'Within 30 days',
  within_90_days: 'Within 90 days',
  researching: 'Researching',
  unknown: '',
};

export default async function LeadsPage() {
  const { rows, staff } = await withStaff('lead.read.assigned', async (db, staff) => ({
    rows: await listLeads(db, staff),
    staff,
  }));

  const tenant = await getTenantById(staff.tenantId);
  const waiting = rows.filter((lead) => !lead.assignedTo).length;

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-medium tracking-tight text-ink-900">Leads</h1>
        <p className="text-sm text-ink-500">
          {staff.can('lead.read.all') ? 'All dealership leads' : 'Assigned to you and unassigned'}
          {waiting > 0 && (
            <>
              {' · '}
              <span className="text-accent-600">{waiting} unassigned</span>
            </>
          )}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="mt-10 rounded border border-dashed border-ink-100 bg-white/50 px-6 py-12 text-center">
          <p className="text-sm text-ink-900">No leads yet.</p>
          <p className="mt-1 text-sm text-ink-500">
            One appears the moment a customer leaves their details with the assistant.
          </p>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-ink-100 overflow-hidden rounded border border-ink-100 bg-white">
          {rows.map((lead) => {
            const timeframe = TIMEFRAMES[lead.purchaseTimeframe ?? 'unknown'] ?? '';

            return (
              <li key={lead.id} className="relative transition-colors hover:bg-ink-50">
                <div className="flex flex-wrap items-start gap-x-5 gap-y-3 px-4 py-4 sm:flex-nowrap">
                  <div className="w-16 shrink-0 pt-0.5">
                    <PriorityBadge priority={lead.priority} />
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* The whole row is the target; the name carries the link so
                        the accessible name is the customer, not "row". */}
                    <Link
                      href={`/portal/leads/${lead.id}`}
                      className="text-[15px] text-ink-900 before:absolute before:inset-0 before:content-[''] hover:underline"
                    >
                      {lead.customerName ?? 'Unnamed customer'}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-ink-500">{lead.customerEmail}</p>

                    <p className="mt-2 text-sm text-ink-900">
                      {lead.wants ? (
                        <>
                          Wants the <span className="font-medium">{lead.wants}</span>
                        </>
                      ) : (
                        <span className="text-ink-500">Nothing specific yet</span>
                      )}
                      {lead.budgetCents !== null && (
                        <span className="text-ink-500">
                          {' · '}
                          around {formatMoney(lead.budgetCents, tenant.currency, tenant.locale)}
                        </span>
                      )}
                    </p>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {timeframe && <Tag>{timeframe}</Tag>}
                      {lead.bookedAt && <Tag tone="good">Test drive booked</Tag>}
                      {lead.financeInterest && <Tag>Financing</Tag>}
                      {lead.tradeInInterest && <Tag>Trade-in</Tag>}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-xs text-ink-500">{relativeTime(lead.lastActivityAt)}</p>
                    <p className="mt-1 text-xs capitalize text-ink-500">
                      {lead.status.replace(/_/g, ' ')}
                    </p>
                    <p className="mt-1 text-xs">
                      {lead.assignedTo ? (
                        <span className="text-ink-500">{lead.assignedTo}</span>
                      ) : (
                        <span className="text-accent-600">Unassigned</span>
                      )}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
