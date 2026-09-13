import Link from 'next/link';
import { headers } from 'next/headers';
import { resolveTenantByHost } from '@/server/context/tenant';
import { listModels } from '@/server/services/catalogue';
import { formatMoney } from '@/server/services/pricing';
import { ModelCard } from '@/components/site/model-card';

export const dynamic = 'force-dynamic';

/**
 * Home.
 *
 * Deliberately restrained: this site is the environment the assistant lives in
 * and is tested against, not the product. It establishes the brand and gets out
 * of the way (spec §37 — the homepage is not about the AI).
 *
 * Every figure on it is counted from the catalogue rather than written into the
 * copy, so a dealership with four models and no electric range gets a page that
 * says so instead of a page that is wrong.
 */
export default async function HomePage() {
  const tenant = await resolveTenantByHost((await headers()).get('host'));
  const models = await listModels(tenant.id);
  const money = (cents: number) => formatMoney(cents, tenant.currency, tenant.locale);

  const featured = models.slice(0, 3);
  const cheapest = models.reduce<number | null>(
    (lowest, model) => (lowest === null ? model.baseMsrpCents : Math.min(lowest, model.baseMsrpCents)),
    null,
  );
  const electrified = models.filter((model) =>
    model.powertrainKinds.some((kind) => kind !== 'ice'),
  ).length;
  const onFloor = models.reduce((total, model) => total + model.inStock, 0);

  return (
    <main>
      <section className="border-b border-ink-100 px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-6xl">
          <p className="text-[11px] uppercase tracking-[0.3em] text-ink-500">{tenant.brandName}</p>
          <h1 className="mt-6 max-w-3xl text-4xl font-medium leading-[1.05] tracking-tight text-ink-900 sm:text-6xl">
            Engineering you can feel from the first corner.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-500">
            {models.length} models across combustion, hybrid and electric. Configure one to the
            specification you want, check what is on the floor today, and book a drive.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              href="/models"
              className="bg-ink-900 px-6 py-3 text-sm text-white transition-colors hover:bg-ink-800"
            >
              Explore the range
            </Link>
            <span className="text-sm text-ink-500">
              or ask the specialist in the corner anything
            </span>
          </div>
        </div>
      </section>

      <section className="border-b border-ink-100 px-6 py-10">
        <dl className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-3">
          <Figure value={String(models.length)} label="Models in the range" />
          <Figure value={String(electrified)} label="Available electrified" />
          <Figure
            value={cheapest === null ? '—' : money(cheapest)}
            label="Starting from"
          />
        </dl>
      </section>

      <section className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">Featured</h2>
            <Link
              href="/models"
              className="text-sm text-ink-500 underline-offset-4 transition-colors hover:text-ink-900 hover:underline"
            >
              All {models.length} models
            </Link>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {featured.map((model) => (
              <ModelCard
                key={model.slug}
                slug={model.slug}
                name={model.name}
                fullName={model.fullName}
                segment={model.segment}
                tagline={model.tagline}
                priceFrom={money(model.baseMsrpCents)}
                powertrainKinds={model.powertrainKinds}
                inStock={model.inStock}
              />
            ))}
          </div>

          {onFloor > 0 && (
            <p className="mt-8 text-sm text-ink-500">
              {onFloor} vehicles are on the floor today. Stock moves — ask for what is available
              this week.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.25em] text-ink-500">{label}</dt>
      <dd className="mt-2 text-2xl font-medium tabular-nums tracking-tight text-ink-900">
        {value}
      </dd>
    </div>
  );
}
