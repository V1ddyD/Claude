import Link from 'next/link';
import { headers } from 'next/headers';
import { resolveTenantByHost } from '@/server/context/tenant';
import { listModels } from '@/server/services/catalogue';
import { formatMoney } from '@/server/services/pricing';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Models' };

export default async function ModelsPage() {
  const tenant = await resolveTenantByHost((await headers()).get('host'));
  const models = await listModels(tenant.id);

  const byBodyStyle = models.reduce<Record<string, typeof models>>((groups, model) => {
    (groups[model.bodyStyle] ??= []).push(model);
    return groups;
  }, {});

  return (
    <main className="px-6 py-16">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-medium tracking-tight text-ink-900">The range</h1>

        {Object.entries(byBodyStyle).map(([bodyStyle, group]) => (
          <section key={bodyStyle} className="mt-14">
            <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">
              {bodyStyle}
            </h2>
            <div className="mt-6 grid gap-px bg-ink-100 sm:grid-cols-2 lg:grid-cols-3">
              {group.map((model) => (
                <Link
                  key={model.slug}
                  href={`/models/${model.slug}`}
                  className="group bg-ink-50 p-6 transition-colors hover:bg-white"
                >
                  <div className="mb-5 aspect-[16/10] w-full bg-gradient-to-br from-ink-100 to-ink-50" />
                  <p className="text-lg text-ink-900">{model.fullName}</p>
                  <p className="mt-1 text-sm text-ink-500">{model.segment}</p>
                  {model.tagline && (
                    <p className="mt-3 text-sm leading-relaxed text-ink-500">{model.tagline}</p>
                  )}
                  <p className="mt-4 text-sm tabular-nums text-ink-900">
                    From {formatMoney(model.baseMsrpCents, tenant.currency, tenant.locale)}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
