/**
 * Understanding what the customer asked for, without a model.
 *
 * Pattern matching, not intelligence — and the honest consequence is that it
 * handles the paths a dealership actually sees and says so plainly when it
 * cannot. It is deterministic, which makes it a genuinely useful thing to
 * demonstrate a workflow with: the same sentence produces the same result
 * every time.
 *
 * NOTHING here knows a dealership's catalogue.
 *
 * Model names arrive as a vocabulary read from the tenant's own range, and
 * trims, colours and powertrains are captured as the words the customer used
 * and resolved later against what the tools actually returned. That is the
 * difference between a demo and a product: add a model to the catalogue and it
 * is understood on the next request, with no change here.
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
  | 'service'
  | 'human'
  | 'thanks'
  | 'unknown';

/** Purchase timeframes, as the signals schema defines them. */
export type Timeframe =
  | 'immediately'
  | 'within_30_days'
  | 'one_to_three_months'
  | 'three_to_six_months'
  | 'over_six_months';

export interface Understanding {
  intent: Intent;
  /** Catalogue slugs the message named, in the order they appeared. */
  modelSlugs: string[];
  /**
   * Content words, for resolving against real trims, colours and powertrains.
   *
   * Captured loosely and resolved strictly: a word that matches nothing in the
   * catalogue is simply dropped, so over-capturing here is safe and
   * under-capturing is not.
   */
  words: string[];
  budgetCents?: number;
  bodyStyle?: 'sedan' | 'coupe' | 'suv' | 'crossover' | 'pickup' | 'wagon';
  electric?: boolean;
  awd?: boolean;
  seats?: number;
  name?: string;
  email?: string;
  phone?: string;
  /** An explicit yes, for confirmation steps. */
  affirmative: boolean;
  dateHint?: string;
  termMonths?: number;
  timeframe?: Timeframe;
  financeInterest?: boolean;
  tradeInInterest?: boolean;
  negotiating?: boolean;
  justBrowsing?: boolean;
}

/** The tenant's own range. Read from the catalogue, never hardcoded. */
export interface Vocabulary {
  models: { slug: string; name: string }[];
}

/**
 * Words that are never a trim, a colour or an engine.
 *
 * Everything else the customer typed is offered up for resolution, because
 * this cannot know what a dealership calls its trim levels — "Premium",
 * "Summit", "Ultimate", "Black Edition" — and guessing a shape for them is
 * how a scripted assistant stops working on the next tenant.
 */
const STOP_WORDS = new Set([
  'a', 'about', 'all', 'also', 'am', 'an', 'and', 'any', 'anything', 'are', 'around',
  'as', 'at', 'available', 'be', 'been', 'best', 'but', 'buy', 'buying', 'by', 'can',
  'car', 'cars', 'come', 'comes', 'cost', 'costs', 'could', 'dealership', 'did', 'do',
  'does', 'doing', 'each', 'for', 'from', 'get', 'give', 'go', 'going', 'got', 'guys',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hi', 'him', 'his', 'how',
  'i', 'if', 'in', 'interested', 'into', 'is', 'it', 'its', 'just', 'know', 'like',
  'long', 'looking', 'lot', 'make', 'many', 'me', 'model', 'models', 'month', 'months',
  'more', 'most', 'much', 'my', 'need', 'new', 'no', 'not', 'now', 'of', 'ok', 'on',
  'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'please', 'price',
  'prices', 'range', 'really', 'right', 'same', 'say', 'see', 'she', 'should', 'show',
  'so', 'some', 'spec', 'specs', 'take', 'tell', 'than', 'thanks', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'think', 'this',
  'those', 'to', 'today', 'told', 'too', 'two', 'up', 'us', 'use', 'vehicle',
  'vehicles', 'very', 'want', 'was', 'we', 'week', 'weeks', 'well', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'year',
  'years', 'yes', 'you', 'your',
]);

export function understand(text: string, vocabulary?: Vocabulary): Understanding {
  const lower = text.toLowerCase();

  const result: Understanding = {
    intent: 'unknown',
    modelSlugs: findModels(lower, vocabulary),
    words: contentWords(lower),
    affirmative:
      /\b(yes|yeah|yep|sure|please do|go ahead|that works|sounds good|ok|okay|correct|confirm)\b/.test(
        lower,
      ),
  };

  result.budgetCents = undefined;
  result.bodyStyle = findBodyStyle(lower);
  if (/\b(electric|ev|evs|battery|bev)\b/.test(lower)) result.electric = true;
  if (/\b(awd|all.?wheel|4wd|four.?wheel|quattro)\b/.test(lower)) result.awd = true;

  const seats = /\b(\d)\s*(?:seat|seats|seater)\b/.exec(lower);
  if (seats) result.seats = Number(seats[1]);

  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text);
  if (email) result.email = email[0];

  // Looked for in the text with the address already removed: an email is full
  // of digits and punctuation, and half of one reads convincingly as a number.
  const phone = findPhone(email ? text.replace(email[0], ' ') : text);
  if (phone) result.phone = phone;

  result.name = findName(text);
  result.dateHint = findDate(lower);

  const term = /\b(\d{2})\s*(?:months?|mos?)\b/.exec(lower);
  if (term) result.termMonths = Number(term[1]);

  // A phone number is not a budget and a mileage is not a budget. Both are
  // taken out before a figure is read as one.
  result.budgetCents = findBudget(
    [result.email, result.phone]
      .filter((value): value is string => Boolean(value))
      .reduce((rest, value) => rest.replace(value.toLowerCase(), ' '), lower),
  );

  result.timeframe = findTimeframe(lower);
  if (/\b(financ\w*|leas\w*|monthly|per month|a month|each month|apr|instal|credit)\b/.test(lower)) {
    result.financeInterest = true;
  }
  if (/\b(trade.?ins?|part.?exchange|my old car)\b/.test(lower)) result.tradeInInterest = true;
  if (isNegotiating(lower)) result.negotiating = true;
  if (/\b(just (looking|browsing)|no rush|not (buying|ready)|window shopping)\b/.test(lower)) {
    result.justBrowsing = true;
  }

  result.intent = classify(lower, result);
  return result;
}

function classify(lower: string, parsed: Understanding): Intent {
  // Ordered by how unambiguous the signal is, so a sentence containing several
  // cues resolves to the one the customer most likely meant. Plurals are
  // spelled out rather than relied on: \b after "engine" does not match
  // "engines", and a classifier that silently misses every plural sends half
  // the questions a dealership gets down the wrong branch.
  if (/\b(cancel\w*|can't make|cannot make|reschedul\w*)\b/.test(lower)) return 'cancel';
  // Asking to be phoned is a callback; asking to speak to someone is a
  // handoff. Both are "I want a person", and the difference is only how.
  if (/\b(call ?back|call me|ring me|phone me|give me a call)\b/.test(lower)) return 'callback';
  if (/\b(speak to|talk to|salesperson|someone|a human|a person|advisor)\b/.test(lower)) {
    return 'human';
  }
  // Negotiation goes to a person. Quoting list price at someone asking for a
  // discount answers a question they did not ask, and no assistant here has
  // the authority to answer the one they did (spec §15).
  if (parsed.negotiating) return 'human';
  if (/\b(servic\w*|repair\w*|maintenance|mot|oil change|recall|warranty|bodyshop|parts)\b/.test(lower)) {
    return 'service';
  }
  if (parsed.tradeInInterest || /\bwhat(?:'?s| is) my .{0,40}\bworth\b/.test(lower)) {
    return 'trade_in';
  }
  if (/\b(test drives?|drive it|come in and drive|book a drive|driving it)\b/.test(lower)) {
    return 'test_drive';
  }
  if (parsed.financeInterest || /\b(per month|a month|each month)\b/.test(lower)) return 'finance';
  if (/\b(in stock|availab\w*|on the lot|do you have|got any|ready to go)\b/.test(lower)) {
    // "What SUVs do you have around 50k?" is a search worded as a stock
    // question. Without a named car there is nothing to check the lot for.
    const searchable = parsed.bodyStyle || parsed.budgetCents || parsed.electric || parsed.seats;
    if (parsed.modelSlugs.length > 0 || !searchable) return 'stock';
  }
  if (/\b(compare|versus| vs | v )\b|\bdifference between\b|\bwhich is better\b/.test(lower)) {
    return 'compare';
  }
  if (/\b(open|opening hours|what time|when are you)\b/.test(lower)) return 'hours';
  // "contact" only where it asks for ours. "Please contact me" is a customer
  // agreeing to be called, not a request for the showroom address.
  if (
    /\b(where are you|address|located|directions|phone number)\b/.test(lower) ||
    /\b(how (can|do) (i|we) (contact|reach)|contact (details|number|info))\b/.test(lower)
  ) {
    return 'location';
  }
  if (/\b(colou?rs?|paint)\b/.test(lower)) return 'colours';
  if (/\b(standard|equipment|features?|kit)\b/.test(lower)) return 'features';
  if (/\b(options?|packages?|extras|add.?ons?)\b/.test(lower)) return 'options';
  if (/\b(engines?|motors?|powertrains?|drivetrains?|range|batter(y|ies)|horsepower|hp|power|economy|mpg|litres?)\b/.test(lower)) {
    return 'powertrains';
  }
  if (/\b(trims?|versions?|grades?|levels?)\b/.test(lower)) return 'trims';
  if (/\b(how much|prices?|costs?|msrp|starting at|starts at)\b/.test(lower)) return 'price';
  if (/\b(thanks|thank you|cheers|appreciate)\b/.test(lower)) return 'thanks';
  if (/^\s*(hi|hello|hey|good (morning|afternoon|evening))\b/.test(lower)) return 'greeting';

  // A bare colour word routes here only once nothing stronger has claimed the
  // message, so "how much is the S5 in black" is still a price question.
  if (namesAColour(lower) && parsed.modelSlugs.length > 0) return 'colours';

  // A budget is a search criterion only when they have not said which car.
  // "I want the S5 Premium and I have $55,000" is a configuration with a
  // budget attached, not a request to be shown the range under $55,000.
  if (
    parsed.modelSlugs.length === 0 &&
    (parsed.budgetCents || parsed.bodyStyle || parsed.electric || parsed.seats)
  ) {
    return 'search_vehicles';
  }
  if (parsed.modelSlugs.length > 1) return 'compare';

  // Naming a car is not the same as asking something answerable about it.
  // "Does the S5 tow a three horse trailer?" gets an honest "I do not know"
  // rather than an overview that answers a question nobody asked.
  if (parsed.modelSlugs.length === 1 && wantsOverview(lower)) return 'vehicle_overview';

  return 'unknown';
}

function isNegotiating(lower: string): boolean {
  return /\b(best price|best you can do|discount|deal on|knock (off|something)|beat (that|this)|haggl\w*|negotiat\w*|cash price|lowest)\b/.test(
    lower,
  );
}

function wantsOverview(lower: string): boolean {
  if (
    /\b(tell me about|about the|what'?s the|what is the|overview|interested in|looking at|show me|more on|details on|i want|i'?d like|i am after|thinking about|considering)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  // "the S5", "S5?" — a bare mention is a request to hear about it.
  return lower.replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).length <= 4;
}

/**
 * Models the message named, from the tenant's own range.
 *
 * Matched on the slug and on the name — both the whole of it and the part
 * after the brand, since "Sinclair S5", "the S5" and "s5" are the same car and
 * a customer uses all three.
 */
function findModels(lower: string, vocabulary?: Vocabulary): string[] {
  const found: string[] = [];

  for (const model of vocabulary?.models ?? []) {
    const aliases = new Set<string>([model.slug.toLowerCase(), model.name.toLowerCase()]);
    const words = model.name.trim().split(/\s+/);
    // "Sinclair S5" -> "s5". Dropped only when something is left to drop to.
    if (words.length > 1) aliases.add(words.slice(1).join(' ').toLowerCase());

    const matched = [...aliases].some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // The optional plural is not cosmetic: "do you have any S5s in stock" is
      // how the question is actually asked. Word-boundary matched so a
      // single-letter model does not fire on every stray letter.
      return new RegExp(`\\b${escaped}s?\\b`).test(lower);
    });

    if (matched) found.push(model.slug);
  }

  return found;
}

function contentWords(lower: string): string[] {
  return [...new Set(
    (lower.match(/[a-z0-9][a-z0-9.'-]*/g) ?? []).filter(
      (word) => word.length > 1 && !STOP_WORDS.has(word),
    ),
  )];
}

function findBudget(lower: string): number | undefined {
  // A distance is never a price, so mileage is removed before anything is read
  // as a figure.
  const text = lower
    .replace(/\d[\d,\s]*\s*(km|kms|kilometres|kilometers|miles|mi)\b/g, ' ')
    // "fifty thousand", "50 grand"
    .replace(/\bgrand\b/g, 'k');

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

  const spelled = findSpelledBudget(text);
  if (spelled && plausible(spelled)) return spelled * 100;

  return undefined;
}

/** "around fifty thousand", "sixty five thousand". */
function findSpelledBudget(text: string): number | undefined {
  const units: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
    eighty: 80, ninety: 90,
  };
  const ones: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  };

  const match = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](one|two|three|four|five|six|seven|eight|nine))?\s+thousand\b/.exec(
    text,
  );
  if (!match) return undefined;
  return (units[match[1]!]! + (match[2] ? ones[match[2]]! : 0)) * 1000;
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
  if (/\bsuvs?\b/.test(lower)) return 'suv';
  if (/\b(pickups?|trucks?|ute)\b/.test(lower)) return 'pickup';
  if (/\b(coupes?|two.?door)\b/.test(lower)) return 'coupe';
  if (/\bcrossovers?\b/.test(lower)) return 'crossover';
  if (/\b(saloons?|sedans?)\b/.test(lower)) return 'sedan';
  if (/\b(estates?|wagons?)\b/.test(lower)) return 'wagon';
  return undefined;
}

/**
 * When they intend to buy, mapped onto the bands the scoring rules use.
 *
 * Only from something they said about timing. Enthusiasm is not a timeframe,
 * and a wrongly confident "immediately" is what sends a salesperson after
 * somebody who is a year away (spec §11).
 */
function findTimeframe(lower: string): Timeframe | undefined {
  if (/\b(today|right now|immediately|asap|as soon as possible|this week)\b/.test(lower)) {
    return 'immediately';
  }
  if (/\b(this month|within (a|the) month|next month|(in|within) 30 days|few weeks|couple of weeks)\b/.test(lower)) {
    return 'within_30_days';
  }
  if (/\b((in|within|next) (two|three|2|3) months?|couple of months|next quarter)\b/.test(lower)) {
    return 'one_to_three_months';
  }
  if (/\b((in|within) (four|five|six|4|5|6) months?|later this year|end of the year)\b/.test(lower)) {
    return 'three_to_six_months';
  }
  if (/\b(next year|in a year|over a year|no rush|sometime|eventually)\b/.test(lower)) {
    return 'over_six_months';
  }
  return undefined;
}

function findName(text: string): string | undefined {
  // Only an explicit introduction. Guessing a name from arbitrary capitalised
  // words puts wrong data in front of a salesperson, which is worse than none.
  //
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

  // The model is taken as everything between the make and the end of the
  // phrase, because plenty of them carry digits or two words — "3 Series",
  // "Model 3", "C-Class" — and a single-word capture loses half of them.
  const named =
    /\b(19[5-9]\d|20[0-4]\d)\s+([A-Za-z][\w-]{1,20})(?:\s+([A-Za-z0-9][\w-]*(?:\s+[A-Za-z0-9][\w-]*)?))?/.exec(
      text,
    );
  if (named) {
    vehicle.year = Number(named[1]);
    vehicle.make = named[2];
    const model = named[3]?.replace(/\s+(with|worth|and|at|in|for|is)$/i, '').trim();
    if (model && !/^(with|at|and|worth|is|in|for)$/i.test(model)) vehicle.model = model;
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

/**
 * Colour words, as a language fact rather than a catalogue one.
 *
 * Used ONLY to notice that a colour was mentioned. Which colours exist, what
 * they are called and what they cost all come from the catalogue — so a
 * dealership whose palette is nothing like this one still works.
 */
const COLOUR_WORDS = [
  'black', 'white', 'grey', 'gray', 'silver', 'red', 'blue', 'green', 'yellow',
  'orange', 'purple', 'pink', 'brown', 'beige', 'cream', 'gold', 'bronze', 'copper',
  'teal', 'turquoise', 'lime', 'maroon', 'navy', 'olive', 'tan', 'ivory',
  'champagne', 'burgundy',
];

function namesAColour(lower: string): boolean {
  return COLOUR_WORDS.some((name) => new RegExp(`\\b${name}\\b`).test(lower));
}

/** Every colour word in a message, for resolving against the real palette. */
export function colourWords(text: string): string[] {
  const lower = text.toLowerCase();
  return COLOUR_WORDS.filter((name) => new RegExp(`\\b${name}\\b`).test(lower));
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
  const shown = label.toLowerCase().replace(/\./g, '').replace(/[  ]/g, ' ');
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
