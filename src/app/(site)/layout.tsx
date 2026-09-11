import Link from 'next/link';
import { headers } from 'next/headers';
import { resolveTenantByHost } from '@/server/context/tenant';
import { Assistant } from '@/components/site/assistant';

export const dynamic = 'force-dynamic';

/**
 * The customer site.
 *
 * The assistant is mounted here rather than per page, so it is available
 * throughout the experience (spec §36) and keeps its conversation as the
 * customer moves around.
 *
 * The brand comes from the tenant record. Nothing on this site is hardcoded to
 * Sinclair.
 */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const tenant = await resolveTenantByHost((await headers()).get('host'));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-100 bg-ink-50/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-6">
          <Link
            href="/"
            className="text-sm font-medium tracking-[0.22em] text-ink-900"
          >
            {tenant.brandName.toUpperCase()}
          </Link>
          <nav className="ml-auto flex items-center gap-6 text-sm">
            <Link href="/models" className="text-ink-500 transition-colors hover:text-ink-900">
              Models
            </Link>
            <Link href="/portal" className="text-ink-300 transition-colors hover:text-ink-900">
              Dealer Portal
            </Link>
          </nav>
        </div>
      </header>

      <div className="flex-1">{children}</div>

      <footer className="border-t border-ink-100 px-6 py-10">
        <div className="mx-auto max-w-6xl text-xs text-ink-500">
          <p>
            {tenant.legalName} · {tenant.timezone.replace('_', ' ')}
          </p>
          <p className="mt-1">
            Prices exclude taxes, registration and dealer fees. Figures shown by the
            assistant are estimates unless stated otherwise.
          </p>
        </div>
      </footer>

      <Assistant
        brandName={tenant.brandName}
        greeting={`Ask me anything about the ${tenant.brandName} range — specifications, prices, what's in stock, or booking a test drive.`}
        suggestions={[
          'What SUVs do you have under $60,000?',
          'Compare the S5 and the E5',
          'What can I test drive this week?',
        ]}
      />
    </div>
  );
}
