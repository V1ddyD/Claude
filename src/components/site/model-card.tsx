import Link from 'next/link';
import type { Route } from 'next';

/**
 * A vehicle in the range.
 *
 * There are no photographs. Every model's `hero_image_url` is null and this is
 * a demonstration catalogue, so the card used to carry a grey gradient in the
 * shape of a missing picture — which reads as a page that failed to load
 * rather than a page that was designed.
 *
 * So the space carries the nameplate instead, set the way a badge on a boot lid
 * is set, and the card carries what a customer scanning the range actually
 * wants: what it runs on, and whether one is on the floor today. When real
 * photography arrives it belongs exactly here.
 */

const POWERTRAIN_LABELS: Record<string, string> = {
  ice: 'Petrol',
  hybrid: 'Hybrid',
  phev: 'Plug-in hybrid',
  bev: 'Electric',
};

export function ModelCard({
  slug,
  name,
  fullName,
  segment,
  tagline,
  priceFrom,
  powertrainKinds,
  inStock,
}: {
  slug: string;
  name: string;
  fullName: string;
  segment: string;
  tagline: string | null;
  priceFrom: string;
  powertrainKinds: string[];
  inStock: number;
}) {
  return (
    <Link
      href={`/models/${slug}` as Route}
      className="group flex flex-col overflow-hidden rounded border border-ink-100 bg-white transition-colors hover:border-ink-300"
    >
      <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-gradient-to-br from-ink-100 to-ink-50">
        <span
          aria-hidden
          className="select-none text-4xl font-medium tracking-[0.18em] text-ink-300 transition-colors group-hover:text-ink-500"
        >
          {name.toUpperCase()}
        </span>
        {inStock > 0 && (
          <span className="absolute left-4 top-4 bg-ink-900 px-2 py-1 text-[10px] uppercase tracking-wider text-white">
            {inStock} in stock
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-6">
        <p className="text-lg text-ink-900">{fullName}</p>
        <p className="mt-1 text-sm text-ink-500">{segment}</p>
        {tagline && <p className="mt-3 text-sm leading-relaxed text-ink-500">{tagline}</p>}

        <div className="mt-4 flex flex-wrap gap-1.5">
          {powertrainKinds.map((kind) => (
            <span
              key={kind}
              className="border border-ink-100 px-1.5 py-0.5 text-[11px] leading-4 text-ink-500"
            >
              {POWERTRAIN_LABELS[kind] ?? kind}
            </span>
          ))}
        </div>

        <p className="mt-5 text-sm tabular-nums text-ink-900">From {priceFrom}</p>
      </div>
    </Link>
  );
}
