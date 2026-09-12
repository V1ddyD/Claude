/**
 * Understanding what the customer asked for, without a model.
 *
 * Pattern matching, not intelligence — and the honest consequence is that it
 * handles the paths a dealership actually sees and says so plainly when it
 * cannot. It is deterministic, which makes it a genuinely useful thing to
 * demonstrate a workflow with: the same sentence produces the same result
 * every time.
 *
 * It drives the SAME tools the model does. Swapping this for Claude changes
 * which client the conversation uses and nothing else.
 */

export type Intent =
  | 'greeting'
  | 'search_vehicles'
  | 'vehicle_overview'
  | 'powertrains'
  | 'trims'
  | 'colours'
  | 'options'
  | 'features'
  | 'price'
  | 'compare'
  | 'stock'
  | 'finance'
  | 'hours'
  | 'location'
  | 'test_drive'
  | 'cancel'
  | 'callback'
  | 'trade_in'
  | 'human'
  | 'thanks'
  | 'unknown';

export interface Understanding {
  intent: Intent;
  modelSlugs: string[];
  trimHint?: string;
  powertrainHint?: string;
  colourHint?: string;
  budgetCents?: number;
  bodyStyle?: 'sedan' | 'coupe' | 'suv' | 'crossover' | 'pickup' | 'wagon';
  electric?: boolean;
  awd?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  /** An explicit yes, for confirmation steps. */
  affirmative: boolean;
  dateHint?: string;
  termMonths?: number;
}

const MODEL_CODES = ['s1', 's3', 's5', 's7', 'x7', 'gt', 'e2', 'e5', 't4', 'r'];

const TRIMS: Record<string, string> = {
  core: 'CORE', premium: 'PREMIUM', luxury: 'LUXURY', sport: 'SPORT',
  'sport plus': 'SPORT_PLUS', performance: 'PERFORMANCE', executive: 'EXECUTIVE',
  touring: 'TOURING', track: 'TRACK', work: 'WORK', adventure: 'ADVENTURE',
  summit: 'SUMMIT',
};

const COLOURS: Record<string, string> = {
  black: 'OBSIDIAN', obsidian: 'OBSIDIAN', white: 'GLACIER', glacier: 'GLACIER',
  grey: 'GRAPHITE', gray: 'GRAPHITE', graphite: 'GRAPHITE', blue: 'MERIDIAN',
  meridian: 'MERIDIAN', silver: 'SLATE', slate: 'SLATE', red: 'CARMINE',
  carmine: 'CARMINE', yellow: 'SIGNAL',
};

export function understand(text: string): Understanding {
  const lower = text.toLowerCase();

  const result: Understanding = {
    intent: 'unknown',
    modelSlugs: findModels(lower),
    affirmative: /\b(yes|yeah|yep|sure|please do|go ahead|that works|sounds good|ok|okay)\b/.test(lower),
  };

  const trim = Object.keys(TRIMS).find((name) => lower.includes(name));
  if (trim) result.trimHint = TRIMS[trim];

  const colour = Object.keys(COLOURS).find((name) => new RegExp(`\\b${name}\\b`).test(lower));
  if (colour) result.colourHint = COLOURS[colour];

  if (/\b(2\.0|2 litre|2l|four cylinder)\b/.test(lower)) result.powertrainHint = '2.0';
  if (/\b(3\.0|inline.?six|straight.?six|six cylinder)\b/.test(lower)) result.powertrainHint = '3.0';
  if (/\b(hybrid)\b/.test(lower)) result.powertrainHint = 'hybrid';
  if (/\b(v8|4\.4)\b/.test(lower)) result.powertrainHint = '4.4';

  result.bodyStyle = findBodyStyle(lower);
  if (/\b(electric|ev|battery|bev)\b/.test(lower)) result.electric = true;
  if (/\b(awd|all.?wheel|4wd|four.?wheel|quattro)\b/.test(lower)) result.awd = true;

  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text);
  if (email) result.email = email[0];

  // Looked for in the text with the address already removed: an email is full
  // of digits and punctuation, and half of one reads convincingly as a number.
  const phone = findPhone(email ? text.replace(email[0], ' ') : text);
  if (phone) result.phone = phone;

  result.name = findName(text);
  result.dateHint = findDate(lower);

  // A phone number is not a budget and a mileage is not a budget. Both are
  // taken out before a figure is read as one.
  result.budgetCents = findBudget(
    [result.email, result.phone]
      .filter((value): value is string => Boolean(value))
      .reduce((rest, value) => rest.replace(value.toLowerCase(), ' '), lower),
  );

  const term = /\b(\d{2})\s*(?:months?|mos?)\b/.exec(lower);
  if (term) result.termMonths = Number(term[1]);

  result.intent = classify(lower, result);
  return result;
}

function classify(lower: string, parsed: Understanding): Intent {
  // Ordered by how unambiguous the signal is, so a sentence containing several
  // cues resolves to the one the customer most likely meant.
  // Plurals are spelled out rather than relied on: \b after "engine" does not
  // match "engines", and a classifier that silently misses every plural sends
  // half the questions a dealership gets down the wrong branch.
  if (/\b(cancel\w*|can't make|cannot make|reschedul\w*)\b/.test(lower)) return 'cancel';
  if (/\b(speak to|talk to|call me|salesperson|someone|a human|a person|advisor)\b/.test(lower)) {
    return /\bcall me\b/.test(lower) ? 'callback' : 'human';
  }
  if (/\b(trade.?ins?|part.?exchange|my old car|worth for my)\b/.test(lower)) return 'trade_in';
  if (/\b(test drives?|drive it|come in and drive|book a drive)\b/.test(lower)) return 'test_drive';
  if (/\b(financ\w*|monthly|per month|a month|each month|payments?|leas\w*|apr|instal)/.test(lower)) {
    return 'finance';
  }
  if (/\b(in stock|availab\w*|on the lot|do you have|got any)\b/.test(lower)) return 'stock';
  if (/\b(compare|versus| vs |difference between|which is better)\b/.test(lower)) return 'compare';
  if (/\b(open|opening hours|what time|when are you)\b/.test(lower)) return 'hours';
  if (/\b(where are you|address|located|directions|phone number)\b/.test(lower)) return 'location';
  if (/\b(colou?rs?|paint)\b/.test(lower)) return 'colours';
  if (/\b(standard|equipment|features?|spec)\b/.test(lower)) return 'features';
  if (/\b(options?|packages?|extras|add.?ons?)\b/.test(lower)) return 'options';
  if (/\b(engines?|motors?|powertrains?|drivetrains?|range|batter(y|ies))\b/.test(lower)) {
    return 'powertrains';
  }
  if (/\b(trims?|versions?|grades?|which levels)\b/.test(lower)) return 'trims';
  if (/\b(how much|prices?|costs?|msrp|starting at)\b/.test(lower)) return 'price';
  if (/\b(thanks|thank you|cheers|appreciate)\b/.test(lower)) return 'thanks';
  if (/^\s*(hi|hello|hey|good (morning|afternoon|evening))\b/.test(lower)) return 'greeting';

  if (parsed.budgetCents || parsed.bodyStyle || parsed.electric) return 'search_vehicles';
  if (parsed.modelSlugs.length > 1) return 'compare';

  // Naming a car is not the same as asking something answerable about it.
  // "Does the S5 tow a three horse trailer?" gets an honest "I do not know"
  // rather than an overview that answers a question nobody asked.
  if (parsed.modelSlugs.length === 1 && wantsOverview(lower)) return 'vehicle_overview';

  return 'unknown';
}

function wantsOverview(lower: string): boolean {
  if (
    /\b(tell me about|about the|what'?s the|what is the|overview|interested in|looking at|show me|more on|details on)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  // "the S5", "S5?" — a bare mention is a request to hear about it.
  return lower.replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).length <= 4;
}

function findModels(lower: string): string[] {
  const found: string[] = [];
  for (const code of MODEL_CODES) {
    // Word-boundary matched so "s5" does not fire on "is 5 seats" and the
    // single-letter R does not fire on every stray r.
    if (new RegExp(`\\b${code}\\b`).test(lower)) found.push(code);
  }
  return found;
}

function findBudget(lower: string): number | undefined {
  // A distance is never a price, so mileage is removed before anything is read
  // as a figure.
  const text = lower.replace(/\d[\d,\s]*\s*(km|kms|kilometres|kilometers|miles|mi)\b/g, ' ');

  const withK = /(\d{1,3})\s?k\b/.exec(text);
  if (withK) {
    const value = Number(withK[1]) * 1000;
    if (plausible(value)) return value * 100;
  }

  const grouped = /(\d{1,3})[,\s](\d{3})\b/.exec(text);
  if (grouped) {
    const value = Number(`${grouped[1]}${grouped[2]}`);
    if (plausible(value)) return value * 100;
  }

  const plain = /\b(\d{4,6})\b/.exec(text);
  if (plain) {
    const value = Number(plain[1]);
    if (plausible(value)) return value * 100;
  }
  return undefined;
}

/** Wide enough for a used runabout, narrow enough to exclude a year or a postcode. */
function plausible(value: number): boolean {
  return value >= 5_000 && value <= 500_000;
}

/**
 * A phone number, by how many digits it has rather than how it is punctuated.
 *
 * A date and a price are both digits and separators too; ten to fifteen digits
 * is what tells them apart.
 */
function findPhone(text: string): string | undefined {
  const match = /(\+?\d[\d\s().-]{7,}\d)/.exec(text);
  if (!match) return undefined;
  const digits = match[1]!.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15 ? match[1]!.trim() : undefined;
}

function findBodyStyle(lower: string): Understanding['bodyStyle'] {
  if (/\bsuv\b/.test(lower)) return 'suv';
  if (/\b(pickup|truck|ute)\b/.test(lower)) return 'pickup';
  if (/\b(coupe|two.?door)\b/.test(lower)) return 'coupe';
  if (/\b(crossover)\b/.test(lower)) return 'crossover';
  if (/\b(saloon|sedan)\b/.test(lower)) return 'sedan';
  if (/\b(estate|wagon)\b/.test(lower)) return 'wagon';
  return undefined;
}

function findName(text: string): string | undefined {
  // Only an explicit introduction. Guessing a name from arbitrary capitalised
  // words puts wrong data in front of a salesperson, which is worse than none.
  // Case is spelled out rather than flagged: /i/ would apply to the capture
  // too, and the capitalisation is the only thing separating a name from an
  // ordinary word.
  const patterns = [
    /\b(?:[Ii]'?m|[Ii] am|[Mm]y name is|[Tt]his is|[Ii]t'?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\b[Nn]ame'?s\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] && !/^(looking|interested|just|here|not|after)$/i.test(match[1])) {
      return match[1];
    }
  }
  return undefined;
}

function findDate(lower: string): string | undefined {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const named = days.find((day) => lower.includes(day));
  if (named) return named;
  if (/\btomorrow\b/.test(lower)) return 'tomorrow';
  if (/\bthis week\b/.test(lower)) return 'this week';
  if (/\bnext week\b/.test(lower)) return 'next week';
  if (/\bweekend\b/.test(lower)) return 'saturday';
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(lower);
  return iso?.[1];
}

/**
 * A name given in direct reply to a request for one.
 *
 * Separate from findName on purpose. Guessing a name from any capitalised word
 * is how wrong data reaches a salesperson, so that only ever happens here —
 * after the assistant has asked for a name and the customer is answering it.
 */
export function nameFromReply(text: string): string | undefined {
  const introduced = findName(text);
  if (introduced) return introduced;

  const stripped = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/\+?\d[\d\s().-]{5,}/g, ' ')
    .replace(
      /\b(yes|yeah|yep|sure|ok|okay|please|thanks|thank you|hi|hello|and|my|name|is|it'?s|i'?m|i am|that'?s|fine|contact|me|you|can|sounds good)\b/gi,
      ' ',
    )
    .replace(/[^A-Za-z'\-\s]/g, ' ');

  const capitalised = stripped.match(/\b[A-Z][a-zA-Z'-]+\b/g) ?? [];
  if (capitalised.length >= 1 && capitalised.length <= 3) return capitalised.join(' ');

  // Plenty of people type their name in lower case. Accepted only when what is
  // left after stripping is short enough to be a name and nothing else.
  const words = stripped.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3 && words.every((w) => w.length >= 2)) {
    return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
  }
  return undefined;
}

/** The alphabet booking codes are drawn from — no vowels, no lookalikes. */
export function findConfirmationCode(text: string): string | undefined {
  return /\b([23456789BCDFGHJKLMNPQRSTVWXZ]{6})\b/.exec(text.toUpperCase())?.[1];
}

/** "the second one", "number 2", "2" — a choice from a numbered list. */
export function findOrdinal(text: string): number | undefined {
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  const lower = text.toLowerCase();
  const word = words.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (word >= 0) return word;
  const digit = /\b(?:option|number|slot)?\s*([1-5])\b(?!\s*(?:am|pm|:|k\b))/.exec(lower);
  return digit ? Number(digit[1]) - 1 : undefined;
}

export interface TradeInVehicle {
  year?: number;
  make?: string;
  model?: string;
  mileageKm?: number;
  condition?: 'excellent' | 'good' | 'fair' | 'poor';
}

/** "2019 Toyota Camry, 80,000 km, good condition". */
export function findTradeInVehicle(text: string): TradeInVehicle {
  const vehicle: TradeInVehicle = {};

  const named = /\b(19[5-9]\d|20[0-4]\d)\s+([A-Za-z][\w-]{1,20})(?:\s+([A-Za-z][\w-]{1,20}))?/.exec(text);
  if (named) {
    vehicle.year = Number(named[1]);
    vehicle.make = named[2];
    if (named[3] && !/^(with|at|and)$/i.test(named[3])) vehicle.model = named[3];
  } else {
    const year = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(text);
    if (year) vehicle.year = Number(year[1]);
  }

  const mileage = /\b(\d{1,3}(?:[,\s]\d{3})+|\d{1,6})\s*(k\b|km|kms|kilometres|kilometers|miles|mi)\b/i.exec(text);
  if (mileage) {
    const amount = Number(mileage[1]!.replace(/[,\s]/g, ''));
    const unit = mileage[2]!.toLowerCase();
    // "80k" means eighty thousand; miles are converted, because the field is km
    // and storing a mile count in it would understate every trade-in by 60%.
    const km = unit === 'k' ? amount * 1000 : amount;
    vehicle.mileageKm = unit === 'miles' || unit === 'mi' ? Math.round(km * 1.60934) : km;
  }

  const condition = /\b(excellent|good|fair|poor)\b/i.exec(text);
  if (condition) vehicle.condition = condition[1]!.toLowerCase() as TradeInVehicle['condition'];

  return vehicle;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Whether something the customer said picks out an offered time.
 *
 * Matched against the label the diary produced, never re-derived from the
 * timestamp: the customer chose from the words they were shown, so those are
 * the words their answer has to agree with.
 */
export function saidMatchesSlot(label: string, said: string): boolean {
  // Intl puts a narrow no-break space between the time and a.m./p.m.
  const shown = label.toLowerCase().replace(/\./g, '').replace(/[\u202f\u00a0]/g, ' ');
  const text = said.toLowerCase().replace(/\./g, '');

  const day = DAYS.find((name) => text.includes(name));
  if (day && !shown.includes(day)) return false;

  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text);
  if (time) return shown.includes(`${Number(time[1])}:${time[2] ?? '00'} ${time[3]}`);

  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return label.includes(iso[1]!);

  return Boolean(day);
}

/**
 * Which of the times the assistant listed the customer picked.
 *
 * Resolved against the list as it was actually shown — parsed back out of the
 * assistant's own message — so "the first one" keeps meaning the time on the
 * screen even if the diary has moved on since.
 */
export function chosenFromOffer(offered: string, said: string): string | undefined {
  const labels = [...offered.matchAll(/^\s*(\d)\.\s+(.+?)\s*$/gm)].map((m) => m[2]!);
  if (labels.length === 0) return undefined;

  const index = findOrdinal(said);
  if (index !== undefined && index < labels.length) return labels[index];

  const matched = labels.filter((label) => saidMatchesSlot(label, said));
  return matched.length === 1 ? matched[0] : undefined;
}
