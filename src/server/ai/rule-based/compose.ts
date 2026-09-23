import type { Step } from './state';
import {
  voiceFor, paragraphs, sentences,
  MORE_TAILS, type Voice,
} from './voice';

/**
 * Turning a tool result into something worth reading.
 *
 * Every figure here is a value a tool returned. Nothing is padded, rounded, or
 * inferred — if a figure is not in the result it does not appear in the reply.
 * That is the same grounding rule the system prompt asks the model to follow,
 * except here it is the only thing the code can do.
 *
 * How it reads is the other half, and it follows a handful of rules:
 *
 *   lead with a sentence   every list is introduced by what it is ("The S5
 *                          comes in three trims:"), never dropped on the
 *                          customer cold
 *   say less               lists are cut to what a person reads, and the rest
 *                          is offered rather than pasted
 *   one layout             a bold name, then a line of facts. The website
 *                          renders the bold and the dashes as a list; a
 *                          direct message strips the markup and turns the
 *                          dashes into bullets (channels/plain-text.ts), so
 *                          one reply reads cleanly on both
 *   no em dashes           colons, commas and full stops, as a person types
 */

type Json = Record<string, unknown>;

/** What a reply knows beyond the tool result itself. */
export interface DescribeContext {
  seed: number;
  /** The assistant's previous message, so a phrasing is not used twice in a row. */
  avoid?: string;
  /** The car being discussed, by the name customers use. */
  modelName?: string;
  /** Show every row instead of a shortlist: the customer asked for the lot. */
  expanded?: boolean;
  firstName?: string;
  email?: string;
  phone?: string;
  now?: Date;
}

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/** The `{ formatted, cents }` shape every price passes through. */
function money(value: unknown): string | undefined {
  return str(obj(value).formatted);
}

/** A sentence starts with a capital, even when its first word came from data. */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Small numbers as words.
 *
 * "Three engines" reads as speech; "3 engines" reads as a table. Only up to
 * ten, because "twenty-seven" is harder to read than the digits are.
 */
export function count(value: number): string {
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return words[value] ?? String(value);
}

function plural(value: number, noun: string, many = `${noun}s`): string {
  return `${count(value)} ${value === 1 ? noun : many}`;
}

/** "a, b and c": prose, not a list. */
export function sentenceList(items: string[], joiner = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}`;
}

/**
 * As much of a list as anyone reads, and a count of the rest.
 *
 * A paint range runs to a dozen colours and an options list longer than that.
 * Printing all of them answers the question and loses the customer on the way,
 * so the list is cut and the remainder is offered — which is what a person
 * would do, and it keeps the full list one word away.
 */
function shortlist<T>(items: T[], cap: number, ctx: DescribeContext): { shown: T[]; rest: number } {
  if (ctx.expanded) return { shown: items, rest: 0 };
  return { shown: items.slice(0, cap), rest: Math.max(0, items.length - cap) };
}

/**
 * The offer that follows a cut list. Empty when nothing was cut.
 *
 * The tail comes from MORE_TAILS, because the next turn recognises a "yes" to
 * this offer by finding one of those exact tails in what was said.
 */
function andMore(rest: number, v: Voice, noun: string): string {
  if (rest === 0) return '';
  return `There ${rest === 1 ? 'is' : 'are'} ${count(rest)} more ${noun}. ${v.pick('more:tail', MORE_TAILS)}`;
}

function voice(ctx: DescribeContext): Voice {
  return voiceFor(ctx.seed, ctx.avoid ?? '');
}

/** "The S5" when we know the car, a neutral subject when we do not. */
function theCar(ctx: DescribeContext): string {
  return ctx.modelName ? `The ${shortName(ctx.modelName)}` : 'It';
}

/** "Sinclair S5" is "the S5" in conversation, as a salesperson would say it. */
function shortName(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words.slice(1).join(' ') : name;
}

export function describe(step: Step, context: DescribeContext | number = 0): string {
  const ctx: DescribeContext = typeof context === 'number' ? { seed: context } : context;
  if (step.isError) return apologise(step);
  const result = obj(step.result);
  const v = voice(ctx);

  switch (step.name) {
    case 'searchVehicles':
      return describeSearch(result, v, ctx);
    case 'getVehicle':
      return describeVehicle(result);
    case 'getVehiclePowertrains':
      return describePowertrains(result, v, ctx);
    case 'getVehicleTrims':
      return describeTrims(result, v, ctx);
    case 'getVehicleColours':
      return describeColours(result, v, ctx);
    case 'getVehicleOptions':
      return describeOptions(result, v, ctx);
    case 'getVehicleFeatures':
      return describeFeatures(result, v, ctx);
    case 'calculateVehiclePrice':
      return describePrice(result);
    case 'compareVehicles':
      return describeComparison(step.result, v);
    case 'rankModels':
      return describeRanking(result, v, ctx);
    case 'rankTrims':
      return describeTrimLadder(result, v);
    case 'checkInventory':
      return describeStock(result, v, ctx);
    case 'calculateFinanceEstimate':
      return describeEstimate(result);
    case 'getDealershipInformation':
      return describeDealership(result, v);
    case 'getDealershipHours':
      return describeHours(result, ctx);
    case 'createTestDrive':
      return describeBooking(result, v, ctx);
    case 'cancelTestDrive':
      return describeCancellation(result, v);
    case 'createCallbackRequest':
      return describeRequest(result, v, 'One of our specialists will give you a call.');
    case 'createTradeInRequest':
      return describeRequest(
        result,
        v,
        'That books an appraisal, not a valuation: what your car is worth needs a proper look in person, and the team will arrange that with you.',
      );
    case 'createFinancingRequest':
      return describeRequest(
        result,
        v,
        'A finance specialist will review it and confirm the terms with you. Nothing is approved yet.',
      );
    case 'requestHumanHandoff':
      return describeHandoff(result, v);
    case 'createSupportTicket':
      return describeRequest(result, v, 'The team will come back to you with an answer.');
    default:
      return '';
  }
}

/**
 * A failed tool.
 *
 * The message a tool returns on failure is already written for a customer, so
 * it is used as-is rather than translated into something vaguer. What is never
 * shown is why it failed.
 */
function apologise(step: Step): string {
  const message = str(obj(step.result).message);
  return message ?? "I couldn't check that just now. The team can confirm it for you.";
}

/* -------------------------------------------------------------------------- */
/* Finding a car                                                               */
/* -------------------------------------------------------------------------- */

function describeSearch(result: Json, v: Voice, ctx: DescribeContext): string {
  const models = list(result.models);
  if (models.length === 0) {
    return v.pick('search:none', [
      "Nothing matches that exactly, I'm afraid. Tell me what matters most and I'll find the closest thing we build.",
      'Nothing in the range fits that precisely. What matters most to you? I can find the nearest thing.',
      "Nothing quite fits that. Tell me the one thing it has to do and I'll see what comes closest.",
    ]);
  }

  const { shown, rest } = shortlist(models, 4, ctx);
  const lines = shown.map((model) => {
    const tagline = str(model.tagline);
    return `- **${str(model.name)}**: ${str(model.segment)}, from ${money(model.priceFrom)}${tagline ? `. ${tagline}` : ''}`;
  });

  const lead =
    models.length === 1
      ? v.pick('search:one', ['One car fits that nicely:', 'Just the one fits that:', 'One of ours fits that:'])
      : v.pick('search:many', [
          `${capitalise(count(models.length))} of ours fit that:`,
          `That narrows it to ${count(models.length)}:`,
          `There are ${count(models.length)} that fit:`,
        ]);

  return paragraphs(lead, lines.join('\n'), andMore(rest, v, 'that fit'));
}

/**
 * A car, properly introduced.
 *
 * This is the reply to "tell me about the S5", and it is the one most worth
 * getting right: it is where a customer decides whether to keep talking. So it
 * reads like the first page of a brochure rather than a spec sheet — what the
 * car is, what it costs, what it is like — and then the facts a buyer asks
 * about next, a line each, all of them from the catalogue.
 */
function describeVehicle(result: Json): string {
  const name = str(result.name) ?? 'This model';
  const tagline = str(result.tagline);
  const from = money(result.priceFrom);
  const to = money(result.priceTo);
  const price = from && to && from !== to ? `from ${from} to ${to}` : from ? `from ${from}` : '';

  const facts: string[] = [];

  const engines = strings(result.powertrains);
  const power = obj(result.horsepower);
  const min = num(power.min);
  const max = num(power.max);
  if (engines.length) {
    const hp = min && max ? (min === max ? ` (${max} hp)` : ` (${min} to ${max} hp)`) : '';
    facts.push(`- Engines: ${sentenceList(engines, 'or')}${hp}`);
  }

  const drives = strings(result.drivetrains);
  if (drives.length === 1) facts.push(`- Drive: ${drives[0]} on every version`);
  else if (drives.length > 1) facts.push(`- Drive: ${sentenceList(drives, 'or')}`);

  const gearboxes = strings(result.transmissions);
  if (gearboxes.length) facts.push(`- Gearbox: ${sentenceList(gearboxes, 'or')}`);

  const fuel = num(result.bestFuelL100);
  if (fuel) facts.push(`- Economy: from ${fuel} L/100km`);

  const range = num(result.bestElectricRangeKm);
  if (range) facts.push(`- Electric range: up to ${range} km on a charge`);

  const trims = strings(result.trims);
  if (trims.length) facts.push(`- Trims: ${sentenceList(trims)}`);

  const palette = obj(result.colourCounts);
  const paints = num(palette.exterior) ?? 0;
  const interiors = num(palette.interior) ?? 0;
  if (paints || interiors) {
    facts.push(
      `- Colours: ${sentenceList(
        [paints ? plural(paints, 'paint') : '', interiors ? plural(interiors, 'interior') : ''].filter(Boolean),
      )}`,
    );
  }

  const stock = num(result.inStock);
  if (stock !== undefined) {
    facts.push(stock > 0 ? `- In stock: ${count(stock)} ready now` : '- In stock: none on site today');
  }

  return paragraphs(
    tagline ? `**${name}**: ${tagline}` : `**${name}**`,
    [str(result.segment), price].filter(Boolean).join(', ') + '.',
    str(result.overview),
    facts.length ? `At a glance:\n${facts.join('\n')}` : '',
  );
}

/* -------------------------------------------------------------------------- */
/* One car, one aspect                                                         */
/* -------------------------------------------------------------------------- */

function describePowertrains(result: Json, v: Voice, ctx: DescribeContext): string {
  const powertrains = list(result.powertrains);
  if (powertrains.length === 0) {
    return v.pick('pt:none', [
      "I don't have the engine detail for that one to hand.",
      "I haven't got the engine line-up for that car to hand.",
    ]);
  }

  const { shown, rest } = shortlist(powertrains, 4, ctx);
  const lines = shown.map((pt) => {
    // Every one of these is a column the dealership filled in. An empty one is
    // left out rather than filled with a plausible figure.
    const facts = [
      num(pt.horsepower) ? `${num(pt.horsepower)} hp` : '',
      num(pt.torqueNm) ? `${num(pt.torqueNm)} Nm` : '',
      str(pt.drivetrain),
      str(pt.transmission),
      num(pt.electricRangeKm) ? `${num(pt.electricRangeKm)} km on the battery` : '',
      num(pt.batteryKwh) ? `${num(pt.batteryKwh)} kWh battery` : '',
      num(pt.fuelConsumptionL100) ? `${num(pt.fuelConsumptionL100)} L/100km` : '',
    ].filter(Boolean);

    const what = str(pt.engine) ?? str(pt.motor);
    return `- **${str(pt.name)}**${what ? `: ${what}` : ''}\n  ${facts.join(' · ')}`;
  });

  const lead =
    powertrains.length === 1
      ? `${theCar(ctx)} comes with one powertrain:`
      : `${theCar(ctx)} comes with a choice of ${count(powertrains.length)}:`;

  return paragraphs(lead, lines.join('\n'), andMore(rest, v, 'engines'));
}

function describeTrims(result: Json, v: Voice, ctx: DescribeContext): string {
  const trims = list(result.trims);
  if (trims.length === 0) return "I don't have the trim levels for that one to hand.";

  const { shown, rest } = shortlist(trims, 5, ctx);
  const lines = shown.map((t) => {
    // The dealership's own one-line description of the trim, where they wrote
    // one. It says more about the difference than the price step does.
    const summary = str(t.summary);
    return `- **${str(t.name)}**: from ${money(t.priceFrom)}${summary ? `. ${summary}` : ''}`;
  });

  return paragraphs(
    `${theCar(ctx)} comes in ${plural(trims.length, 'trim')}:`,
    lines.join('\n'),
    andMore(rest, v, 'trims'),
  );
}

function describeColours(result: Json, v: Voice, ctx: DescribeContext): string {
  const colours = list(result.colours);
  if (colours.length === 0) return "I don't have the colour list for that one to hand.";

  const line = (c: Json) => {
    const surcharge = money(c.surcharge);
    const finish = str(c.finish);
    return `- **${str(c.name)}**${finish ? ` (${finish})` : ''}${surcharge ? `: ${surcharge}` : ''}`;
  };

  // Kept apart. A paint and a leather in one list reads as nine paints, three
  // of which the customer would be surprised to find on the outside of the car.
  const exteriorAll = colours.filter((c) => c.kind !== 'interior');
  const interiorAll = colours.filter((c) => c.kind === 'interior');
  const exterior = shortlist(exteriorAll, 6, ctx);
  const interior = shortlist(interiorAll, 4, ctx);

  const counted = [
    exteriorAll.length ? plural(exteriorAll.length, 'paint colour') : '',
    interiorAll.length ? plural(interiorAll.length, 'interior') : '',
  ].filter(Boolean);

  return paragraphs(
    `${theCar(ctx)} comes in ${sentenceList(counted)}.`,
    exterior.shown.length ? `Paint:\n${exterior.shown.map(line).join('\n')}` : '',
    interior.shown.length ? `Interior:\n${interior.shown.map(line).join('\n')}` : '',
    v.pick('col:note', [
      'Anything without a price beside it is included.',
      'Anything with no price next to it comes as standard.',
      "Where there's no price shown, it's included.",
    ]),
    andMore(exterior.rest + interior.rest, v, 'colours'),
  );
}

function describeOptions(result: Json, v: Voice, ctx: DescribeContext): string {
  const options = list(result.options);
  if (options.length === 0) return 'That version has no separate options. Everything is standard.';

  const standard = shortlist(options.filter((o) => o.included === true), 6, ctx);
  const extra = shortlist(options.filter((o) => o.included !== true), 6, ctx);

  const parts: string[] = [];
  if (extra.shown.length) {
    parts.push(
      `Here's what you can add:\n${extra.shown
        .map((o) => {
          const what = str(o.description);
          return `- **${str(o.name)}**: ${money(o.price) ?? 'price on request'}${what ? `. ${what}` : ''}`;
        })
        .join('\n')}`,
    );
  }
  if (standard.shown.length) {
    parts.push(
      `Already included at this trim: ${sentenceList(standard.shown.map((o) => str(o.name) ?? ''))}` +
        `${standard.rest > 0 ? `, and ${count(standard.rest)} more` : ''}.`,
    );
  }
  return paragraphs(...parts, andMore(extra.rest, v, 'options'));
}

function describeFeatures(result: Json, v: Voice, ctx: DescribeContext): string {
  const equipment = obj(result.standardEquipment);
  const categories = Object.entries(equipment);
  if (categories.length === 0) return "I don't have the equipment list for that version to hand.";

  // Three categories, five items each. A full standard-equipment list is forty
  // lines long and reads as a legal document; this reads as an answer.
  const { shown, rest } = shortlist(categories, 3, ctx);

  const lines = shown.map(([category, value]) => {
    const labels = shortlist(strings(value), 5, ctx);
    return (
      `- **${capitalise(category)}**: ${sentenceList(labels.shown)}` +
      `${labels.rest > 0 ? `, and ${count(labels.rest)} more` : ''}`
    );
  });

  return paragraphs(
    `Here's what comes as standard${ctx.modelName ? ` on the ${shortName(ctx.modelName)}` : ''}:`,
    lines.join('\n'),
    andMore(rest, v, 'categories of equipment'),
  );
}

function describePrice(result: Json): string {
  const lines = list(result.lines).map((l) => `- ${str(l.label)}: ${str(l.amount)}`);
  const total = money(result.total);
  const summary = str(result.summary);

  return paragraphs(
    summary && total
      ? `The **${summary}** comes to **${total}**.`
      : total
        ? `That comes to **${total}**.`
        : '',
    lines.length ? `How that's made up:\n${lines.join('\n')}` : '',
    str(result.note),
  );
}

function describeComparison(result: unknown, v: Voice): string {
  const models = list(result);
  if (models.length === 0) return "I couldn't put those side by side just now.";

  const blocks = models.map((m) => {
    const facts = [
      money(m.priceFrom) ? `- Price: from ${money(m.priceFrom)}` : '',
      num(m.maxHorsepower) ? `- Power: up to ${num(m.maxHorsepower)} hp` : '',
      strings(m.drivetrains).length ? `- Drive: ${sentenceList(strings(m.drivetrains), 'or')}` : '',
      num(m.bestConsumptionL100) ? `- Economy: from ${num(m.bestConsumptionL100)} L/100km` : '',
      num(m.bestElectricRangeKm) ? `- Electric range: up to ${num(m.bestElectricRangeKm)} km` : '',
      strings(m.trims).length ? `- Trims: ${sentenceList(strings(m.trims))}` : '',
    ].filter(Boolean);
    return `**${str(m.name)}**, ${str(m.segment)}\n${facts.join('\n')}`;
  });

  return paragraphs(
    v.pick('compare:lead', ["Here's how they line up:", 'Side by side:', "Here's how they compare:"]),
    ...blocks,
    v.pick('compare:close', [
      "Tell me which matters most to you: space, pace or running costs, and I'll help you narrow it down.",
      "If you tell me what matters most, I'll say which one I'd look at first.",
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* Rankings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A ranking, led by the answer rather than by the table.
 *
 * The customer asked which one is cheapest, or fastest, or most popular. The
 * first line answers exactly that in a sentence; the rest of the order follows
 * for anyone who wants it. Leading with the table makes them do the sorting
 * again themselves, which is the work they asked to have done.
 *
 * The measure is always stated. A ranking without its basis is an opinion
 * wearing a list's clothes, and this assistant does not have opinions.
 */
function describeRanking(result: Json, v: Voice, ctx: DescribeContext): string {
  const models = list(result.models);
  const measure = str(result.measure);

  if (result.enough === false || models.length === 0) {
    return v.pick('rank:none', [
      "I don't have enough to call that one honestly. What I can do is order the range by price, power, electric range or fuel consumption. Any of those useful?",
      "There isn't enough behind that for me to give you a straight answer, and I'd rather not invent one. I can rank them on price, power, range or economy instead.",
    ]);
  }

  const leader = models[0]!;
  const value = str(leader.value);

  const { shown, rest } = shortlist(models.slice(1), 3, ctx);
  const others = shown.map((model) => {
    const figure = str(model.value);
    return `- **${str(model.name)}**${figure ? `: ${figure}` : ''}`;
  });

  return paragraphs(
    `That would be the **${str(leader.name)}**${value ? `, ${value}` : ''}.`,
    measure ? `That's going on ${measure}.` : '',
    others.length ? `After that:\n${others.join('\n')}` : '',
    andMore(rest, v, 'after those'),
  );
}

/**
 * The trim ladder, and what each step actually buys.
 *
 * "Which trim is best value" has no factual answer, so none is given. What is
 * given is the thing the question is really reaching for: what the step costs
 * and what it adds as standard. Where one step adds more per pound than the
 * others, that is said — WITH the measure, so it reads as arithmetic rather
 * than as a recommendation, which is all it is.
 */
function describeTrimLadder(result: Json, v: Voice): string {
  const trims = list(result.trims);
  if (trims.length === 0) return "I don't have the trim detail for that one to hand.";

  const lines = trims.map((trim, index) => {
    const step = money(trim.stepUp);
    const kit = strings(trim.adds);
    const more = num(trim.moreAdds) ?? 0;

    // The bottom rung adds nothing — there is nothing below it. Saying it
    // "adds" its standard kit reads as though the cheapest car were an upgrade.
    const verb = index === 0 ? 'Comes with' : 'Adds';
    const gained = kit.length
      ? ` ${verb} ${sentenceList(kit)}${more > 0 ? `, and ${count(more)} more` : ''}.`
      : '';

    return `- **${str(trim.name)}**: from ${money(trim.priceFrom)}${step ? ` (${step} more than the one below)` : ''}.${gained}`;
  });

  const best = str(result.bestStepUp);
  const winner = best ? trims.find((trim) => str(trim.code) === best) : undefined;

  return paragraphs(
    `Here's the **${str(result.model)}** line-up, cheapest first:`,
    lines.join('\n'),
    winner
      ? `${v.pick('value:lead', [
          'Purely on the arithmetic',
          'If you go strictly on what you get for the money',
          'On paper, at least',
        ])}, the **${str(winner.name)}** is the step that earns its keep. It adds the most kit for what it costs. ${v.pick('value:caveat', [
          "Whether it's the right one for you is a different question, mind.",
          "That said, the right one is the one with the kit you'll actually use.",
          "Worth saying that's arithmetic, not advice.",
        ])} Happy to go through any of them properly.`
      : "Honestly, none of the steps stands out on the numbers. It comes down to which kit you'd actually use. Tell me what matters to you and I'll tell you which one has it.",
  );
}

/* -------------------------------------------------------------------------- */
/* Stock and money                                                             */
/* -------------------------------------------------------------------------- */

function describeStock(result: Json, v: Voice, ctx: DescribeContext): string {
  const available = list(result.available);
  if (available.length === 0) {
    return v.pick('stock:none', [
      "We don't have one on site right now, I'm afraid.",
      'None of those here at the moment, sorry.',
      'Nothing like that in stock today, unfortunately.',
    ]);
  }

  const total = Math.max(num(result.total) ?? available.length, available.length);
  const { shown } = shortlist(available, 3, ctx);
  const rest = Math.max(0, total - shown.length);

  const lines = shown.map((unit) => {
    const colour = str(unit.exteriorColour);
    return (
      `- **${str(unit.trim)}** ${str(unit.powertrain)}` +
      `${colour ? ` in ${colour}` : ''}, ${money(unit.price)}` +
      `${str(unit.estimatedDelivery) ? `, available from ${str(unit.estimatedDelivery)}` : ''}` +
      ` (stock ${str(unit.stockNumber)})`
    );
  });

  const lead =
    total === 1
      ? v.pick('stock:one', ['Good news, we have one here right now:', "There's one on site at the moment:", 'We have one ready now:'])
      : v.pick('stock:many', [
          `Good news, we have ${count(total)} here right now:`,
          `There are ${count(total)} on site at the moment:`,
          `We have ${count(total)} ready now:`,
        ]);

  // Only offered when the extra rows can actually be shown: the stock tool
  // returns a handful, and offering "the lot" and then showing the same three
  // would be a promise the next reply could not keep.
  const canShowMore = rest > 0 && available.length > shown.length;

  return paragraphs(
    lead,
    lines.join('\n'),
    canShowMore
      ? andMore(available.length - shown.length, v, 'on site')
      : rest > 0
        ? `Plus ${count(rest)} more on site.`
        : '',
    v.pick('stock:caveat', [
      "Stock moves quickly, so that's as of today.",
      "That's today's picture; stock does move.",
    ]),
  );
}

function describeEstimate(result: Json): string {
  return paragraphs(
    `That works out at about **${str(result.monthlyPayment)} a month** over ${num(result.termMonths)} months at ${result.aprPercent}% APR.`,
    [
      str(result.amountFinanced) ? `- Amount financed: ${str(result.amountFinanced)}` : '',
      str(result.totalOfPayments) ? `- Total repayable: ${str(result.totalOfPayments)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    str(result.disclaimer),
  );
}

/* -------------------------------------------------------------------------- */
/* The dealership                                                              */
/* -------------------------------------------------------------------------- */

function describeDealership(result: Json, v: Voice): string {
  const address = str(result.address);
  const contact = [
    str(result.phone) ? `- Phone: ${str(result.phone)}` : '',
    str(result.email) ? `- Email: ${str(result.email)}` : '',
  ].filter(Boolean);
  const hours = num(result.salesResponseHours);

  if (!address && contact.length === 0) return "I don't have our contact details to hand just now.";

  return paragraphs(
    address
      ? v.pick('where', [`You'll find us at ${address}.`, `We're at ${address}.`, `The showroom is at ${address}.`])
      : '',
    contact.length ? `${address ? 'Or get in touch directly:' : 'You can reach us here:'}\n${contact.join('\n')}` : '',
    hours ? `The sales team usually replies within ${plural(hours, 'business hour')}.` : '',
  );
}

/** "09:00" as "9am", "17:30" as "5:30pm": how a person says a time. */
function clock(time: string | undefined): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (h === undefined || Number.isNaN(h)) return time;
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${suffix}`;
}

function describeHours(result: Json, ctx: DescribeContext): string {
  const hours = list(result.hours);
  if (hours.length === 0) return "I don't have our opening hours to hand just now.";

  const department = str(result.department) === 'service' ? 'service department' : 'showroom';
  // Monday first, as a week is read; the tool returns Sunday first.
  const week = [...hours.slice(1), ...hours.slice(0, 1)];
  const lines = week.map((day) =>
    day.closed === true
      ? `- ${str(day.day)}: closed`
      : `- ${str(day.day)}: ${clock(str(day.opens))} to ${clock(str(day.closes))}`,
  );

  const closures = list(result.upcomingClosures).map(
    (c) => `- ${str(c.startsOn)}${str(c.endsOn) !== str(c.startsOn) ? ` to ${str(c.endsOn)}` : ''}: ${str(c.reason)}`,
  );

  return paragraphs(
    `Our ${department} hours:`,
    lines.join('\n'),
    today(hours, str(result.timezone), ctx.now),
    closures.length ? `We're also closed on:\n${closures.join('\n')}` : '',
  );
}

/**
 * Whether we are open right now, in the dealership's own time.
 *
 * The line a person actually wants when they ask "are you open?" at 6.45 on a
 * Tuesday. Worked out from the same hours the list shows, and the clock the
 * turn was answered at, so it can never disagree with the table above it.
 */
function today(hours: Json[], timezone: string | undefined, now: Date | undefined): string {
  if (!now || !timezone) return '';
  let weekday: string;
  let time: string;
  try {
    weekday = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long' }).format(now);
    time = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(now);
  } catch {
    return '';
  }

  const index = hours.findIndex((day) => str(day.day) === weekday);
  const row = hours[index];
  if (!row) return '';

  // The next day that opens, for "we're closed today" to point somewhere.
  const next = [1, 2, 3, 4, 5, 6, 7]
    .map((offset) => hours[(index + offset) % hours.length]!)
    .find((day) => day.closed !== true);
  const reopen = next ? ` We're open again ${str(next.day)} from ${clock(str(next.opens))}.` : '';

  if (row.closed === true) return `We're closed today (${weekday}).${reopen}`;

  const opens = str(row.opens) ?? '';
  const closes = str(row.closes) ?? '';
  if (time < opens) return `Today (${weekday}) we're open from ${clock(opens)} until ${clock(closes)}.`;
  if (time < closes) return `We're open right now, until ${clock(closes)} today.`;
  return `We've closed for today.${reopen}`;
}

/* -------------------------------------------------------------------------- */
/* Things that were done                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A booking, confirmed.
 *
 * Laid out as the details a person checks — when, which car, the code — rather
 * than as a sentence they have to parse to find the time. The email line says
 * "on its way", never "sent": queued is not delivered (spec §21, §54).
 */
function describeBooking(result: Json, v: Voice, ctx: DescribeContext): string {
  const email = str(result.confirmationEmail) ?? '';
  const who = ctx.firstName ? `, ${ctx.firstName}` : '';

  const details = [
    `- When: **${str(result.when)}**`,
    str(result.vehicle) ? `- Car: ${str(result.vehicle)}` : '',
    `- Confirmation code: **${str(result.confirmationCode)}**`,
    `- Reference: ${str(result.ticketNumber)}`,
  ].filter(Boolean);

  return paragraphs(
    v.pick('book:lead', [
      `You're all booked in${who}!`,
      `That's booked${who}.`,
      `All sorted${who}, you're booked in.`,
    ]),
    details.join('\n'),
    email.startsWith('queued')
      ? sentences(
          `A confirmation email is on its way${ctx.email ? ` to ${ctx.email}` : ''}.`,
          ctx.phone ? 'The team has your number in case anything changes on the day.' : '',
        )
      : "I couldn't queue a confirmation email, so do keep that code somewhere safe.",
    v.pick('book:close', [
      'If you need to move it, just send me your confirmation code. See you then!',
      "Looking forward to seeing you. If plans change, message me with your code and I'll sort it.",
      "We'll see you then. Need to change it? Just send me the code.",
    ]),
  );
}

function describeCancellation(result: Json, v: Voice): string {
  return paragraphs(
    `${v.pick('cancel:lead', ['All done.', 'Done.', 'That\'s sorted.'])} Your booking for ${str(result.was)} is cancelled.`,
    v.pick('cancel:close', [
      "The slot's free again, so just say if you'd like another time.",
      'If you want to rebook, just tell me when suits and I will check the diary.',
    ]),
  );
}

function describeRequest(result: Json, v: Voice, next: string): string {
  const queued = str(result.confirmationEmail) === 'queued';
  return paragraphs(
    `${v.pick('req:lead', ['Done.', 'All sorted.', "That's with the team."])} Your reference is **${str(result.ticketNumber)}**.`,
    sentences(next, queued ? 'A confirmation email is on its way too.' : ''),
  );
}

function describeHandoff(result: Json, v: Voice): string {
  return paragraphs(
    `${v.pick('handoff:lead', ["I've passed this to one of our specialists.", "That's with one of our specialists now."])} Your reference is **${str(result.ticketNumber)}**.`,
    "They'll be in touch shortly; they haven't replied yet, so keep an eye on your inbox.",
  );
}

/* -------------------------------------------------------------------------- */
/* Answers assembled from more than one result                                 */
/* -------------------------------------------------------------------------- */

/**
 * "Does the S5 have CarPlay?", answered from the equipment and options lists.
 *
 * Standard, optional, or not listed — and "not listed" is said as exactly
 * that, never as "no". A catalogue that does not mention heated seats is not
 * proof the car has none, and a customer told "no" about something the car has
 * is a sale lost to a data-entry gap.
 */
export interface TrimEquipment {
  trimName: string;
  features?: Step;
  options?: Step;
}

export function describeFeatureCheck(
  terms: string[],
  words: string[],
  trims: TrimEquipment[],
  ctx: DescribeContext,
): { text: string; found: boolean } {
  const matches = featureMatcher(terms, words);
  const car = ctx.modelName ? `the ${shortName(ctx.modelName)}` : 'it';
  const v = voice(ctx);

  // For each trim: is it standard, an option, or not listed?
  const verdicts = trims.map((trim) => {
    const standard = Object.values(obj(obj(trim.features?.result).standardEquipment)).flatMap(strings);
    const extras = list(obj(trim.options?.result).options);
    const standardHit =
      standard.find(matches) ??
      extras.filter((o) => o.included === true).map((o) => str(o.name) ?? '').find(matches);
    const optionHit = extras.find((o) => o.included !== true && matches(str(o.name) ?? ''));
    return { trim: trim.trimName, standardHit, optionHit };
  });

  const standardOn = verdicts.filter((row) => row.standardHit);
  const optionalOn = verdicts.filter((row) => !row.standardHit && row.optionHit);

  if (standardOn.length === 0 && optionalOn.length === 0) {
    return {
      found: false,
      text: `That isn't listed in the equipment for ${car}, though I'd rather not tell you it hasn't got it when the list might not be complete.`,
    };
  }

  const label = capitalise((standardOn[0]?.standardHit ?? str(optionalOn[0]?.optionHit?.name)) ?? 'It');
  const every = standardOn.length === trims.length && trims.length > 0;
  const parts: string[] = [];

  if (every) {
    parts.push(
      `${v.pick('fc:yes', ['Yes, it does.', 'It does, yes.', 'Good news, it does.'])} Every version of ${car} comes with ${lowerFirst(label)} as standard.`,
    );
  } else if (standardOn.length > 0) {
    parts.push(
      `${v.pick('fc:some', ['On some versions, yes.', 'Yes, depending on the trim.'])} You'll find ${lowerFirst(label)} as standard on the ${sentenceList(standardOn.map((row) => row.trim))}.`,
    );
  }

  if (optionalOn.length > 0) {
    const option = optionalOn[0]!.optionHit!;
    const price = money(option.price);
    parts.push(
      `${standardOn.length > 0 ? 'On' : "It's available as an option on"} the ${sentenceList(optionalOn.map((row) => row.trim))}${standardOn.length > 0 ? ", it's available as an option" : ''}: the **${str(option.name)}**${price ? ` for ${price}` : ''}${str(option.description) ? `, which includes ${lowerFirst(str(option.description)!)}` : ''}.`,
    );
  }

  return { found: true, text: paragraphs(...parts) };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * How the dealership's own equipment labels say each named feature.
 *
 * "Sunroof" is written "Panoramic glass roof" and "parking sensors" is "Park
 * assist", so a feature is matched by any of the ways a catalogue labels it.
 * Kept deliberately specific: "wheel" alone would find "heated steering
 * wheel" for a question about alloys, and a wrong "yes, it has that" is the
 * worst answer this function can give.
 */
const FEATURE_KEYWORDS: Record<string, string[]> = {
  carplay: ['carplay'],
  'android auto': ['android'],
  sunroof: ['sunroof', 'moonroof', 'panoramic', 'glass roof', 'sliding roof'],
  'heated seats': ['heated front seat', 'heated seat', 'heated and power', 'heated rear seat', 'seat heating'],
  'ventilated seats': ['ventilated', 'cooled seat'],
  'massage seats': ['massag'],
  leather: ['leather', 'nappa'],
  'cruise control': ['cruise'],
  'lane assist': ['lane'],
  'blind spot': ['blind spot', 'blind-spot'],
  'parking sensors': ['parking sensor', 'park assist', 'parking assist', 'park distance'],
  camera: ['camera', 'surround view'],
  'head-up display': ['head-up', 'head up', 'hud'],
  'wireless charging': ['wireless charg', 'wireless phone'],
  bluetooth: ['bluetooth'],
  navigation: ['navigation', 'sat nav', 'satnav', 'gps'],
  keyless: ['keyless', 'push-button start', 'push button start', 'remote start'],
  towing: ['tow'],
  'roof rails': ['roof rail', 'roof rack'],
  'alloy wheels': ['alloy'],
  headlights: ['headlight', 'led light', 'matrix'],
  'sound system': ['audio', 'sound system', 'speaker', 'harman', 'bose', 'burmester', 'olufsen'],
  display: ['touchscreen', 'centre display', 'center display', 'infotainment'],
  'climate control': ['climate', 'air conditioning'],
  'air suspension': ['air suspension', 'adaptive suspension', 'adaptive damp'],
  tailgate: ['tailgate'],
  'third row': ['third row', '3rd row', 'seven seat', '7 seat', 'three-row', 'three row'],
  isofix: ['isofix'],
  airbags: ['airbag'],
  'driver assist': ['driver assist', 'assisted driving', 'autopilot', 'self-driving'],
};

/** Words that describe the question rather than the equipment. */
const NOT_EQUIPMENT = new Set([
  'standard', 'factory', 'option', 'optional', 'fitted', 'included', 'include', 'come',
  'comes', 'available', 'extra', 'cost', 'price', 'does', 'have', 'with', 'from', 'also',
]);

function featureMatcher(terms: string[], words: string[]): (label: string) => boolean {
  if (terms.length > 0) {
    const keywords = terms.flatMap((term) => FEATURE_KEYWORDS[term] ?? [term]);
    return (label) => {
      const lower = label.toLowerCase();
      return keywords.some((keyword) => lower.includes(keyword));
    };
  }
  // Kit this does not know by name. Every meaningful word must appear, so
  // "roof box" never matches "roof rails".
  const parts = words.filter((word) => word.length >= 3 && !NOT_EQUIPMENT.has(word));
  if (parts.length === 0) return () => false;
  return (label) => {
    const lower = label.toLowerCase();
    return parts.every((part) => lower.includes(part));
  };
}

/**
 * Charging, answered from the powertrains that actually plug in.
 *
 * Battery size and range are in the catalogue; charging times are not, and
 * they depend on the charger as much as the car, so that part is routed to a
 * person rather than estimated.
 */
export function describeCharging(powertrains: Step | undefined, ctx: DescribeContext): { text: string; electric: boolean } {
  const rows = list(obj(powertrains?.result).powertrains);
  const plugIn = rows.filter((row) => row.type === 'bev' || row.type === 'phev');
  const car = ctx.modelName ? `the ${shortName(ctx.modelName)}` : 'it';

  if (plugIn.length === 0) {
    const selfCharging = rows.some((row) => row.type === 'hybrid');
    return {
      electric: false,
      text: selfCharging
        ? `No plug needed on ${car}. Its hybrid charges itself as you drive, and the rest of the range runs on fuel.`
        : `No charging needed on ${car}. It runs on fuel, so it's a normal fill-up at the pump.`,
    };
  }

  const lines = plugIn.map((row) => {
    const facts = [
      num(row.batteryKwh) ? `${num(row.batteryKwh)} kWh battery` : '',
      num(row.electricRangeKm) ? `up to ${num(row.electricRangeKm)} km on a charge` : '',
    ].filter(Boolean);
    return `- **${str(row.name)}**${facts.length ? `: ${facts.join(', ')}` : ''}`;
  });

  const kind = plugIn.every((row) => row.type === 'bev') ? 'fully electric' : 'a plug-in hybrid';
  return {
    electric: true,
    text: paragraphs(`${capitalise(car)} is ${kind}. Here's what each version carries:`, lines.join('\n')),
  };
}

/** Manual or automatic, from the gearboxes the catalogue lists. */
export function describeTransmission(powertrains: Step | undefined, ctx: DescribeContext): string {
  const rows = list(obj(powertrains?.result).powertrains);
  const gearboxes = [...new Set(rows.map((row) => str(row.transmission)).filter((t): t is string => Boolean(t)))];
  const car = ctx.modelName ? `the ${shortName(ctx.modelName)}` : 'this model';

  if (gearboxes.length === 0) return `I don't have the gearbox detail for ${car} to hand.`;

  const manual = gearboxes.some((g) => /manual/i.test(g));
  const lines = rows
    .filter((row) => str(row.transmission))
    .map((row) => `- **${str(row.name)}**: ${str(row.transmission)}`);

  return paragraphs(
    manual
      ? `${capitalise(car)} is offered with a manual as well as an automatic:`
      : `Every version of ${car} is an automatic, so there's no manual option:`,
    lines.join('\n'),
  );
}
