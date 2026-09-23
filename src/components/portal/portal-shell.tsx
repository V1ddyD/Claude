import Link from 'next/link';
import type { Route } from 'next';
import type { StaffContext } from '@/server/auth/require-staff';
import type { Permission } from '@/server/auth/permissions';

/**
 * Portal chrome.
 *
 * Navigation is filtered by permission rather than by role name, so a link
 * never appears for a destination its owner would be refused, and granting a
 * permission updates the navigation for free. Hiding a link is presentation,
 * not protection — every destination re-checks with requireStaff().
 *
 * Only sections that exist appear. There used to be three more, greyed out and
 * titled "Available in M2" — a milestone number from the people building the
 * software, on the navigation of a dealership who has never seen the plan. A
 * menu that is half unusable reads as a portal that is half broken.
 */

interface NavItem {
  label: string;
  permission: Permission;
  href: Route;
}

const NAV: NavItem[] = [
  { label: 'Dashboard', permission: 'customer.read', href: '/portal' },
  { label: 'Leads', permission: 'lead.read.assigned', href: '/portal/leads' },
  { label: 'Appointments', permission: 'appointment.read', href: '/portal/appointments' },
  { label: 'Tickets', permission: 'customer.read', href: '/portal/tickets' },
];

const ROLE_LABEL: Record<string, string> = {
  sales: 'Sales',
  service: 'Service',
  manager: 'Manager',
  admin: 'Administrator',
};

export function PortalShell({
  staff,
  brandName,
  children,
}: {
  staff: Pick<StaffContext, 'fullName' | 'role'> & { can: (p: Permission) => boolean };
  /** From the tenant record. Never a constant — Sinclair is tenant #1, not the product. */
  brandName: string;
  children: React.ReactNode;
}) {
  // `can` already accounts for a broader grant standing in for a narrower one
  // — a manager holds `lead.read.all`, which is `lead.read.assigned` and more.
  const visible = NAV.filter((item) => staff.can(item.permission));

  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-100 bg-white">
        {/*
          On a phone the links drop to their own row and scroll sideways, so the
          header never makes the page wider than the screen. Most of a
          salesperson's day with this is on a phone between customers.
        */}
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-2 px-4 pt-3 sm:px-6 md:h-14 md:flex-nowrap md:pt-0">
          <Link href="/portal" className="text-sm font-medium tracking-[0.2em] text-ink-900">
            {brandName.toUpperCase()}
          </Link>
          <span className="hidden text-[11px] uppercase tracking-widest text-ink-500 sm:inline">
            Dealer Portal
          </span>

          <span className="ml-auto text-right leading-tight md:order-last md:ml-0 md:border-l md:border-ink-100 md:pl-5">
            <span className="block text-sm text-ink-900">{staff.fullName}</span>
            <span className="block text-[11px] uppercase tracking-wider text-ink-500">
              {ROLE_LABEL[staff.role] ?? staff.role}
            </span>
          </span>

          <nav className="order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-5 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 md:order-none md:mx-0 md:ml-auto md:w-auto md:overflow-visible md:px-0 md:pb-0">
            {visible.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="whitespace-nowrap text-sm text-ink-900 transition-colors hover:text-accent-500"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
