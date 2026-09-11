import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { resolveTenantByHost } from '@/server/context/tenant';
import { getModelDetail } from '@/server/services/catalogue';
import { formatMoney } from '@/server/services/pricing';
import { isAppError } from '@/server/errors';

export const dynamic = 'force-dynamic';

/**
 * Model detail.
 *
 * Everything here comes from the catalogue through the same service the
 * assistant uses, so the page and the conversation can never disagree about
 * what is offered or what it costs.
 */
export default async function ModelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await resolveTenantByHost((await headers()).get('host'));

  let detail;
  try {
    detail = await getModelDetail(tenant.id, slug);
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const { model, powertrains, trims, configurations } = detail;
  const money = (cents: number) => formatMoney(cents, tenant.currency, tenant.locale);

  return (
    <main>
      <section className="border-b border-ink-100 px-6 py-16">
        <div className="mx-auto max-w-6xl">
          <p className="text-[11px] uppercase tracking-[0.25em] text-ink-500">{model.segment}</p>
          <h1 className="mt-4 text-4xl font-medium tracking-tight text-ink-900 sm:text-5xl">
            {model.fullName}
          </h1>
          {model.tagline && (
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-500">{model.tagline}</p>
          )}
          <p className="mt-6 text-sm tabular-nums text-ink-900">
            From {money(model.baseMsrpCents)}
          </p>
          <div className="mt-8 aspect-[21/9] w-full bg-gradient-to-br from-ink-100 to-ink-50" />
          {model.overview && (
            <p className="mt-8 max-w-2xl leading-relaxed text-ink-500">{model.overview}</p>
          )}
        </div>
      </section>

      <section className="px-6 py-14">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">Powertrains</h2>
          <div className="mt-6 grid gap-px bg-ink-100 sm:grid-cols-2 lg:grid-cols-3">
            {powertrains.map((powertrain) => (
              <div key={powertrain.code} className="bg-ink-50 p-5">
                <p className="text-ink-900">{powertrain.name}</p>
                <dl className="mt-3 space-y-1 text-sm text-ink-500">
                  <Spec label="Drivetrain" value={powertrain.drivetrain.toUpperCase()} />
                  {powertrain.horsepower && (
                    <Spec label="Power" value={`${powertrain.horsepower} hp`} />
                  )}
                  {powertrain.rangeKm && (
                    <Spec label="Range" value={`${powertrain.rangeKm} km`} />
                  )}
                </dl>
                {/* The matrix, stated plainly: not every engine is offered with
                    every trim, and the page says so rather than implying it. */}
                <p className="mt-3 text-xs text-ink-300">
                  Offered with {[...new Set(powertrain.offeredWithTrims)].join(', ')}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-ink-100 px-6 py-14">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-[11px] uppercase tracking-[0.25em] text-ink-500">Trims</h2>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-left text-[11px] uppercase tracking-wider text-ink-500">
                  <th className="py-3 font-medium">Trim</th>
                  <th className="py-3 font-medium">From</th>
                  <th className="py-3 font-medium">Available with</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {trims.map((trim) => (
                  <tr key={trim.code}>
                    <td className="py-3 text-ink-900">{trim.name}</td>
                    <td className="py-3 tabular-nums text-ink-900">
                      {money(trim.fromPriceCents)}
                    </td>
                    <td className="py-3 text-ink-500">
                      {configurations
                        .filter((c) => c.trimCode === trim.code)
                        .map((c) => c.powertrainName)
                        .join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-8 text-sm text-ink-500">
            Ask the assistant to price a specific build, check what is in stock, or book a
            drive.
          </p>
        </div>
      </section>
    </main>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{label}</dt>
      <dd className="text-ink-900">{value}</dd>
    </div>
  );
}
