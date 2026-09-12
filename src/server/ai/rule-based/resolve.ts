/**
 * Turning the words a customer used into codes the catalogue recognises.
 *
 * This is the whole of how the scripted assistant stays tenant-agnostic. It
 * holds no trim names, no colour names and no engine codes: it is given the
 * rows a tool returned — or the rows the database holds — and asked which of
 * them the customer's words name. A word that names nothing resolves to
 * nothing and is dropped, which is why capturing words loosely upstream is
 * safe and why a dealership with an entirely different range works unchanged
 * (spec §1, §34).
 */

export interface TrimRow {
  code: string;
  name: string;
}

export interface PowertrainRow {
  code: string;
  name: string;
  type: string;
  offeredWithTrims: string[];
}

export interface ColourRow {
  code: string;
  name: string;
  kind?: string;
}

/**
 * Resolving the customer's words against what this model is actually built in.
 *
 * The catalogue is the vocabulary. A word that names nothing in it resolves to
 * nothing and is dropped, which is why capturing loosely upstream is safe: the
 * only names that can ever be acted on are names the dealership uses.
 */
export function resolveTrim(words: string[], trims: TrimRow[]): TrimRow | undefined {
  return bestMatch(trims, (row) => nameParts(row.name).concat(row.code.toLowerCase()), words);
}

/** Drivetrain is its own axis; matching on it would name an engine at random. */
const DRIVETRAIN_WORDS = new Set(['awd', 'rwd', 'fwd', '4wd', '2wd']);

export function resolvePowertrain(
  words: string[],
  powertrains: PowertrainRow[],
): PowertrainRow | undefined {
  const byName = bestMatch(
    powertrains,
    (row) =>
      nameParts(row.name)
        .filter((part) => !DRIVETRAIN_WORDS.has(part))
        .concat(row.code.toLowerCase()),
    words,
  );
  if (byName) return byName;

  // "electric", "hybrid", "petrol" name a kind rather than an engine. The kinds
  // themselves come from the catalogue row, so a tenant with kinds this code
  // has never heard of simply matches nothing here.
  const kinds: Record<string, string[]> = {
    electric: ['bev'], ev: ['bev'], battery: ['bev'],
    hybrid: ['hybrid', 'phev'], 'plug-in': ['phev'],
    petrol: ['ice'], gas: ['ice'], gasoline: ['ice'], diesel: ['ice'],
  };
  for (const word of words) {
    const wanted = kinds[word];
    if (!wanted) continue;
    const hit = powertrains.find((row) => wanted.includes(row.type));
    if (hit) return hit;
  }
  return undefined;
}

export interface ColourRow {
  code: string;
  name: string;
  kind?: string;
}

export function resolveColour(words: string[], colours: ColourRow[]): ColourRow | undefined {
  return bestMatch(colours, (row) => nameParts(row.name), words);
}

function nameParts(name: string): string[] {
  return name.toLowerCase().split(/[\s_-]+/).filter(Boolean);
}

/**
 * The row the customer's words name best.
 *
 * Scored by how much of the row's name they used, so "Sport Plus" wins over
 * "Sport" when both words are present — and ties break towards what was said
 * most recently, because a customer who changes their mind means the new one.
 */
function bestMatch<T>(
  rows: T[],
  keysOf: (row: T) => string[],
  words: string[],
): T | undefined {
  let best: { row: T; matched: number; position: number } | undefined;

  for (const row of rows) {
    const keys = keysOf(row);
    const hits = keys.filter((key) => words.includes(key));
    if (hits.length === 0) continue;

    const position = Math.min(...hits.map((key) => words.indexOf(key)));
    if (
      !best ||
      hits.length > best.matched ||
      (hits.length === best.matched && position < best.position)
    ) {
      best = { row, matched: hits.length, position };
    }
  }

  return best?.row;
}
