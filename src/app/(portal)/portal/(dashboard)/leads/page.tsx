import Link from 'next/link';
import { withStaff } from '@/server/auth/require-staff';
import { listLeads } from '@/server/db/repositories/leads';
import { PriorityBadge } from '@/components/portal/priority-badge';
import { formatMoney } from '@/server/services/pricing';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Leads' };

export default async function LeadsPage() {
  const { rows, staff } = await withStaff('lead.read.assigned', async (db, staff) => ({
    rows: await listLeads(db, staff),
    staff,
  }));

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-medium tracking-tight text-ink-900">Leads</h1>
        <p className="text-sm text-ink-500">
          {staff.can('lead.read.all') ? 'All dealership leads' : 'Assigned to you and unassigned'}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-10 text-sm text-ink-500">
          No leads yet. They appear here the moment a customer gives their details in a
          conversation.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto rounded border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-[11px] uppercase tracking-wider text-ink-500">
                <th className="px-4 py-3 font-medium">Priority</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Summary</th>
                <th className="px-4 py-3 font-medium">Budget</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Assigned</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((lead) => (
                <tr key={lead.id} className="hover:bg-ink-50">
                  <td className="px-4 py-3 align-top">
                    <PriorityBadge priority={lead.priority} />
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Link
                      href={`/portal/leads/${lead.id}`}
                      className="text-ink-900 underline-offset-2 hover:underline"
                    >
                      {lead.customerName ?? 'Unnamed'}
                    </Link>
                    <span className="block text-xs text-ink-500">{lead.customerEmail}</span>
                  </td>
                  <td className="max-w-md px-4 py-3 align-top text-ink-500">
                    {lead.aiSummary ?? '—'}
                  </td>
                  <td className="px-4 py-3 align-top tabular-nums text-ink-900">
                    {lead.budgetCents ? formatMoney(lead.budgetCents, 'CAD', 'en-CA') : '—'}
                  </td>
                  <td className="px-4 py-3 align-top text-ink-500">
                    {lead.status.replace(/_/g, ' ')}
                  </td>
                  <td className="px-4 py-3 align-top text-ink-500">
                    {lead.assignedTo ?? <span className="text-accent-600">Unassigned</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
