import { headers } from 'next/headers';
import { resolveTenantByHost } from '@/server/context/tenant';
import { listModels } from '@/server/services/catalogue';
import { formatMoney } from '@/server/services/pricing';
import { ModelCard } from '@/components/site/model-card';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Models' };

/** Body styles as they are written in the catalogue, in the words used here. */
const BODY_STYLES: Record<string, string> = {
  suv: 'SUVs',
  crossover: 'Crossovers',
  sedan: 'Sedans',
  coupe: 'Coupes',
  pickup: 'Pickups',
  hatchback: 'Hatchbacks',
  wagon: 'Wagons',
  van: 'Vans',
};

export default async function ModelsPage() {
  const tenant = await resolveTenantByHost((await headers()).get('host'));
  const models = await listModels(tenant.id);
  const money = (cents: number) => formatMoney(cents, tenant.currency, tenant.locale);

  const byBodyStyle = models.reduce<Record<string, typeof models>>((groups, model) => {
    (groups[model.bodyStyle] ??= []).push(model);
    return groups;
  }, {});

  const onFloor = models.reduce((total, model) => total + model.inStock, 0);

  return (
    <main className="px-6 py-16">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-medium tracking-tight text-ink-900">The range</h1>
        <p className="mt-3 max-w-xl leading-relaxed text-ink-500">
          {models.length} models, {onFloor} vehicles on the floor today. Prices are the starting
          figure for each model — the assistant will price a specific build.
        </p>

        {Object.entries(byBodyStyle).map(([bodyStyle, group]) => (
          <section key={bodyStyle} className="mt-14">
            <div className="flex items-baseline gap-3">
              <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">
                {BODY_STYLES[bodyStyle] ?? bodyStyle}
              </h2>
              <span className="text-[11px] text-ink-300">{group.length}</span>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.map((model) => (
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
          </section>
        ))}
      </div>
    </main>
  );
}
