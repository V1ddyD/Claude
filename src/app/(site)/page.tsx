import Link from 'next/link';
import { headers } from 'next/headers';
import { resolveTenantByHost } from '@/server/context/tenant';
import { listModels } from '@/server/services/catalogue';
import { formatMoney } from '@/server/services/pricing';

export const dynamic = 'force-dynamic';

/**
 * Home.
 *
 * Deliberately restrained: this site is the environment the assistant lives in
 * and is tested against, not the product. It establishes the brand and gets out
 * of the way (spec §37 — the homepage is not about the AI).
 */
export default async function HomePage() {
  const tenant = await resolveTenantByHost((await headers()).get('host'));
  const models = await listModels(tenant.id);
  const featured = models.slice(0, 3);

  return (
    <main>
      <section className="border-b border-ink-100 px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-6xl">
          <p className="text-[11px] uppercase tracking-[0.3em] text-ink-500">
            {tenant.brandName}
          </p>
          <h1 className="mt-6 max-w-3xl text-4xl font-medium leading-[1.1] tracking-tight text-ink-900 sm:text-6xl">
            Engineering you can feel from the first corner.
          </h1>
          <p className="mt-6 max-w-xl leading-relaxed text-ink-500">
            Ten models across combustion, hybrid and electric. Configure one to the
            specification you want, check what is on the floor today, and book a drive.
          </p>
          <div className="mt-10 flex flex-wrap gap-4">
            <Link
              href="/models"
              className="bg-ink-900 px-6 py-3 text-sm text-white transition-colors hover:bg-ink-800"
            >
              Explore the range
            </Link>
          </div>
        </div>
      </section>

      <section className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">Featured</h2>
          <div className="mt-8 grid gap-px bg-ink-100 sm:grid-cols-3">
            {featured.map((model) => (
              <Link
                key={model.slug}
                href={`/models/${model.slug}`}
                className="group bg-ink-50 p-6 transition-colors hover:bg-white"
              >
                {/* No image is assumed: renders arrive per model, so the
                    placeholder is the default state, not an error state. */}
                <div className="mb-6 aspect-[16/10] w-full bg-gradient-to-br from-ink-100 to-ink-50" />
                <p className="text-lg text-ink-900">{model.fullName}</p>
                <p className="mt-1 text-sm text-ink-500">{model.segment}</p>
                <p className="mt-3 text-sm tabular-nums text-ink-900">
                  From {formatMoney(model.baseMsrpCents, tenant.currency, tenant.locale)}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
