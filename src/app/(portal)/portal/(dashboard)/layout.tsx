import { redirect } from 'next/navigation';
import { requireStaff } from '@/server/auth/require-staff';
import { isAppError } from '@/server/errors';
import { PortalShell } from '@/components/portal/portal-shell';
import { getTenantById } from '@/server/context/tenant';

/**
 * Never prerendered. The portal is per-request by nature: it reads a session
 * and queries tenant-scoped data, neither of which exists at build time.
 */
export const dynamic = 'force-dynamic';


/**
 * The Dealer Portal's authorization boundary.
 *
 * Middleware redirects unauthenticated browsers, but this check is what
 * actually protects the data: middleware can be bypassed, and a layout runs on
 * the server for every request beneath it. Each page and server action beneath
 * this one ALSO calls requireStaff with the permission it needs — a layout
 * proves you are staff, not that you may read this particular thing.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  let staff;
  try {
    staff = await requireStaff();
  } catch (err) {
    if (isAppError(err) && (err.code === 'UNAUTHENTICATED' || err.code === 'FORBIDDEN')) {
      redirect('/portal/sign-in');
    }
    throw err;
  }

  const tenant = await getTenantById(staff.tenantId);
  return (
    <PortalShell staff={staff} brandName={tenant.brandName}>
      {children}
    </PortalShell>
  );
}
