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
 * Sections not yet built render as disabled rather than as links. Linking to a
 * page that does not exist would make the portal look finished and leave staff
 * clicking into errors; `typedRoutes` makes the distinction a compile error.
 */

type NavItem =
  | { label: string; permission: Permission; href: Route }
  | { label: string; permission: Permission; arrives: string };

const NAV: NavItem[] = [
  { label: 'Dashboard', permission: 'customer.read', href: '/portal' },
  { label: 'Leads', permission: 'lead.read.assigned', arrives: 'M3' },
  { label: 'Appointments', permission: 'appointment.read', arrives: 'M4' },
  { label: 'Tickets', permission: 'ticket.sales.read', arrives: 'M4' },
  { label: 'Inventory', permission: 'inventory.read', arrives: 'M2' },
  { label: 'Analytics', permission: 'analytics.read', arrives: 'M5' },
  { label: 'Settings', permission: 'settings.write', arrives: 'M5' },
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
  const visible = NAV.filter(
    (item) =>
      staff.can(item.permission) ||
      // Managers and admins hold the broader `lead.read.all` instead.
      (item.permission === 'lead.read.assigned' && staff.can('lead.read.all')),
  );

  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-100 bg-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-6">
          <Link href="/portal" className="text-sm font-medium tracking-[0.2em] text-ink-900">
            {brandName.toUpperCase()}
          </Link>
          <span className="hidden text-[11px] uppercase tracking-widest text-ink-500 sm:inline">
            Dealer Portal
          </span>

          <nav className="ml-auto flex items-center gap-5">
            {visible.map((item) =>
              'href' in item ? (
                <Link
                  key={item.label}
                  href={item.href}
                  className="text-sm text-ink-900 transition-colors hover:text-accent-500"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  key={item.label}
                  title={`Available in ${item.arrives}`}
                  aria-disabled="true"
                  className="hidden cursor-default text-sm text-ink-300 lg:inline"
                >
                  {item.label}
                </span>
              ),
            )}
            <span className="border-l border-ink-100 pl-5 text-right leading-tight">
              <span className="block text-sm text-ink-900">{staff.fullName}</span>
              <span className="block text-[11px] uppercase tracking-wider text-ink-500">
                {ROLE_LABEL[staff.role] ?? staff.role}
              </span>
            </span>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-10">{children}</main>
    </div>
  );
}
