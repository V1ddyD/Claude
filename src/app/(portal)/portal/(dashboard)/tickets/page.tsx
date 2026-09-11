import Link from 'next/link';
import { and, eq, desc, inArray, or } from 'drizzle-orm';
import { withStaff } from '@/server/auth/require-staff';
import { tickets, customers, staffUsers } from '@/server/db/schema';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tickets' };

/**
 * The ticket queue.
 *
 * This existed as data long before it existed as a screen: the assistant could
 * file a service enquiry and nobody could open it. Sales staff see sales
 * tickets, service staff see service tickets — the permission decides the
 * filter, not the UI.
 */
const SERVICE_TYPES = ['service'] as const;

export default async function TicketsPage() {
  const { rows, seesService, seesSales } = await withStaff(
    'customer.read',
    async (db, staff) => {
      const canSeeSales = staff.can('ticket.sales.read');
      const canSeeService = staff.can('ticket.service.read');

      const typeFilter = canSeeSales && canSeeService
        ? undefined
        : canSeeService
          ? inArray(tickets.type, [...SERVICE_TYPES])
          : or(
              inArray(tickets.type, [
                'sales_enquiry', 'test_drive', 'financing', 'trade_in', 'callback',
                'general', 'support',
              ]),
            );

      return {
        seesSales: canSeeSales,
        seesService: canSeeService,
        rows: await db
          .select({
            id: tickets.id,
            number: tickets.number,
            type: tickets.type,
            status: tickets.status,
            subject: tickets.subject,
            createdAt: tickets.createdAt,
            leadId: tickets.leadId,
            customerName: customers.fullName,
            customerEmail: customers.email,
            assignedTo: staffUsers.fullName,
          })
          .from(tickets)
          .innerJoin(customers, eq(customers.id, tickets.customerId))
          .leftJoin(staffUsers, eq(staffUsers.id, tickets.assignedStaffId))
          .where(and(eq(tickets.tenantId, db.tenantId), ...(typeFilter ? [typeFilter] : [])))
          .orderBy(desc(tickets.createdAt))
          .limit(100),
      };
    },
  );

  const open = rows.filter((t) => t.status === 'open' || t.status === 'in_progress');

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-medium tracking-tight text-ink-900">Tickets</h1>
        <p className="text-sm text-ink-500">
          {open.length} open ·{' '}
          {seesSales && seesService ? 'all queues' : seesService ? 'service' : 'sales'}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-10 text-sm text-ink-500">
          No tickets in your queue. One is raised whenever a customer asks for a callback,
          a trade-in appraisal, financing, or anything the assistant hands over.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto rounded border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-[11px] uppercase tracking-wider text-ink-500">
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 font-medium">Request</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Raised</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((ticket) => (
                <tr key={ticket.id} className="hover:bg-ink-50">
                  <td className="px-4 py-3 align-top font-mono text-[13px] tabular-nums text-ink-900">
                    {ticket.number}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className="block text-ink-900">{ticket.subject}</span>
                    <span className="block text-xs text-ink-500">
                      {ticket.type.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top">
                    {ticket.leadId ? (
                      <Link
                        href={`/portal/leads/${ticket.leadId}`}
                        className="text-ink-900 underline-offset-2 hover:underline"
                      >
                        {ticket.customerName ?? ticket.customerEmail ?? 'Unnamed'}
                      </Link>
                    ) : (
                      <span className="text-ink-900">
                        {ticket.customerName ?? ticket.customerEmail ?? 'Unnamed'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-ink-500">
                    {ticket.status.replace(/_/g, ' ')}
                  </td>
                  <td className="px-4 py-3 align-top text-ink-500">
                    {new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' }).format(
                      ticket.createdAt,
                    )}
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
