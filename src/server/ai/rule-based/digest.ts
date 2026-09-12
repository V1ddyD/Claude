/**
 * Reading the catalogue back out of the system prompt.
 *
 * The rule-based assistant is handed exactly what the model is handed, and
 * nothing more. Parsing the digest rather than querying the database keeps that
 * true: it can only name a car the prompt already told it about, so it cannot
 * offer something this dealership does not sell.
 */

export interface DigestModel {
  slug: string;
  name: string;
  segment: string;
}

export interface Digest {
  brandName: string;
  timezone: string;
  models: DigestModel[];
}

const LINE = /^-\s+(.+?)\s+\(([a-z0-9-]+)\)\s+—\s+([^,]+),\s+from\s+(.+)$/;

export function readDigest(system: string): Digest {
  const models: DigestModel[] = [];

  for (const line of system.split('\n')) {
    const match = LINE.exec(line.trim());
    if (match) {
      // The line's price is matched but deliberately not kept. Nothing may
      // quote a figure the digest carried rather than a tool returned.
      models.push({ name: match[1]!, slug: match[2]!, segment: match[3]! });
    }
  }

  return {
    brandName: /You are a product specialist for (.+?),/.exec(system)?.[1] ?? 'the dealership',
    timezone: /\(([A-Za-z]+\/[A-Za-z_]+)\)/.exec(system)?.[1] ?? 'UTC',
    models,
  };
}

/** YYYY-MM-DD in the dealership's local time, which is the only date it books in. */
export function localDate(now: Date, timezone: string, addDays = 0): string {
  const shifted = new Date(now.getTime() + addDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(shifted);
}
