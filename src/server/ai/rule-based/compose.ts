import type { Step } from './state';
import { voiceFor, maybeNudge, OFFER_DRIVE, type Voice } from './voice';

/**
 * Turning a tool result into something worth reading.
 *
 * Every sentence here is built from a value a tool returned. Nothing is
 * padded, rounded, or inferred — if a figure is not in the result it does not
 * appear in the reply. That is the same grounding rule the system prompt asks
 * the model to follow, except here it is the only thing the code can do.
 */

type Json = Record<string, unknown>;

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

/** The `{ formatted, cents }` shape every price passes through. */
function money(value: unknown): string | undefined {
  return str(obj(value).formatted);
}

/**
 * As much of a list as anyone reads, and a count of the rest.
 *
 * A dealership's paint range runs to a dozen colours and its options list
 * longer than that. Printing all of them answers the question and loses the
 * customer on the way, so the list is cut and the remainder is offered instead
 * — which is what a person would do, and it keeps the full list one word away.
 */
function shortlist<T>(items: T[], cap: number): { shown: T[]; rest: number } {
  return { shown: items.slice(0, cap), rest: Math.max(0, items.length - cap) };
}

/** The offer that follows a cut list. Empty when nothing was cut. */
function andMore(rest: number, v: Voice, key: string, noun: string): string {
  if (rest === 0) return '';
  return v.pick(key, [
    `There are ${rest} more ${noun}. Want the lot?`,
    `${rest} more ${noun} besides. Say the word and I'll list them.`,
    `That's not all of them. ${rest} more if you want them.`,
  ]);
}

/**
 * Small numbers as words.
 *
 * "Three engines" reads as speech; "3 engines" reads as a table. Only up to
 * ten, because "twenty-seven" is harder to read than the digits are.
 */
function count(value: number): string {
  const words = [
    'no', 'one', 'two', 'three', 'four', 'five',
    'six', 'seven', 'eight', 'nine', 'ten',
  ];
  return words[value] ?? String(value);
}

/** A sentence starts with a capital, even when its first word came from data. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a, b and c" — an Oxford-free join, because this is prose, not a list. */
export function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function describe(step: Step, seed = 0): string {
  if (step.isError) return apologise(step);
  const result = obj(step.result);
  const v = voiceFor(seed);

  switch (step.name) {
    case 'searchVehicles':
      return describeSearch(result, v);
    case 'getVehicle':
      return describeVehicle(result, v);
    case 'getVehiclePowertrains':
      return describePowertrains(result, v);
    case 'getVehicleTrims':
      return describeTrims(result, v);
    case 'getVehicleColours':
      return describeColours(result, v);
    case 'getVehicleOptions':
      return describeOptions(result, v);
    case 'getVehicleFeatures':
      return describeFeatures(result, v);
    case 'calculateVehiclePrice':
      return describePrice(result);
    case 'compareVehicles':
      return describeComparison(step.result);
    case 'rankModels':
      return describeRanking(result, v);
    case 'rankTrims':
      return describeTrimLadder(result, v);
    case 'checkInventory':
      return describeStock(result, v);
    case 'calculateFinanceEstimate':
      return describeEstimate(result);
    case 'getDealershipInformation':
      return describeDealership(result);
    case 'getDealershipHours':
      return describeHours(result);
    case 'createTestDrive':
      return describeBooking(result, v);
    case 'cancelTestDrive':
      return describeCancellation(result);
    case 'createCallbackRequest':
      return describeRequest(result, 'A specialist will call you back.');
    case 'createTradeInRequest':
      return describeRequest(
        result,
        'That books an appraisal, not a valuation. What your car is worth needs a proper look in person.',
      );
    case 'createFinancingRequest':
      return describeRequest(
        result,
        'A specialist reviews financing and confirms the terms. Nothing is approved yet.',
      );
    case 'requestHumanHandoff':
      return describeHandoff(result);
    case 'createSupportTicket':
      return describeRequest(result, 'The team will come back to you.');
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

function describeSearch(result: Json, v: Voice): string {
  const models = list(result.models);
  if (models.length === 0) {
    return v.pick('search:none', [
      "Nothing matches that exactly, I'm afraid. Tell me what matters most and I'll find the closest thing we build.",
      'Nothing in the range fits that precisely. What matters most to you? I can find the nearest thing.',
      "Nothing quite fits that. Tell me the one thing it has to do and I'll see what comes closest.",
    ]);
  }

  const { shown, rest } = shortlist(models, 4);
  const lines = shown.map((model) => {
    const tagline = str(model.tagline);
    return `- **${str(model.name)}**: ${str(model.segment)}, from ${money(model.priceFrom)}${tagline ? `. ${tagline}` : ''}`;
  });

  const lead =
    models.length === 1
      ? v.pick('search:one', ['One car fits that', 'Just the one fits that', 'One of ours fits that'])
      : v.pick('search:many', [
          `${models.length} fit that`,
          `${models.length} of ours fit that`,
          `That narrows it to ${models.length}`,
        ]);

  return [`${lead}:`, lines.join('\n'), andMore(rest, v, 'search:more', 'that fit')]
    .filter(Boolean)
    .join('\n\n');
}

function describeVehicle(result: Json, v: Voice): string {
  // getVehicle projects these as plain names, not objects.
  const powertrains = (result.powertrains as string[] | undefined) ?? [];
  const trims = (result.trims as string[] | undefined) ?? [];
  const overview = str(result.overview);

  // Counted, not listed. Somebody who asked "tell me about the S5" wants to
  // know what it is; the names of five engines and four trims is a spec sheet
  // they did not ask for, and it buries the two sentences that answer them.
  // The counts tell them the detail exists, and the next line offers it.
  const depth = [
    powertrains.length ? `${count(powertrains.length)} engine${powertrains.length === 1 ? '' : 's'}` : '',
    trims.length ? `${count(trims.length)} trim${trims.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);

  const parts = [
    `**${str(result.name)}**: ${str(result.segment)}, from ${money(result.priceFrom)}.`,
    overview,
    depth.length ? `${capitalise(sentenceList(depth))} to choose from.` : '',
    // Offered on some turns, not all. A reply that ends in the same invitation
    // every single time is a reply nobody reads the end of.
    maybeNudge(v, 'vehicle:drive', OFFER_DRIVE),
  ];

  return parts.filter(Boolean).join('\n\n');
}

function describePowertrains(result: Json, v: Voice): string {
  const powertrains = list(result.powertrains);
  if (powertrains.length === 0) {
    return v.pick('pt:none', [
      "I don't have the engine detail for that one.",
      "I haven't got powertrain detail for that car.",
      "That one I don't have engine detail for.",
    ]);
  }

  const { shown, rest } = shortlist(powertrains, 4);
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

  return [lines.join('\n'), andMore(rest, v, 'pt:more', 'engines')]
    .filter(Boolean)
    .join('\n\n');
}

function describeTrims(result: Json, v: Voice): string {
  const trims = list(result.trims);
  if (trims.length === 0) {
    return v.pick('trim:none', [
      "I don't have the trim detail for that one.",
      "I haven't got the trim levels for that car.",
    ]);
  }
  const { shown, rest } = shortlist(trims, 5);
  const lines = shown.map((t) => {
    // The dealership's own one-line description of the trim, where they wrote
    // one. It says more about the difference than the price step does.
    const summary = str(t.summary);
    return `- **${str(t.name)}**: from ${money(t.priceFrom)}${summary ? `. ${summary}` : ''}`;
  });

  return [lines.join('\n'), andMore(rest, v, 'trim:more', 'trims')]
    .filter(Boolean)
    .join('\n\n');
}

function describeColours(result: Json, v: Voice): string {
  const colours = list(result.colours);
  if (colours.length === 0) {
    return v.pick('col:none', [
      "I don't have the colour list for that one.",
      "I haven't got the paint options for that car.",
    ]);
  }

  const line = (c: Json) => {
    const surcharge = money(c.surcharge);
    const finish = str(c.finish);
    return `- **${str(c.name)}**${finish ? ` (${finish})` : ''}${surcharge ? `: ${surcharge}` : ''}`;
  };

  // Kept apart. A paint and a leather in one list reads as nine paints, three
  // of which the customer would be surprised to find on the outside of the car.
  const exterior = shortlist(colours.filter((c) => c.kind !== 'interior'), 6);
  const interior = shortlist(colours.filter((c) => c.kind === 'interior'), 4);
  const rest = exterior.rest + interior.rest;

  return [
    exterior.shown.length ? `Paint:\n${exterior.shown.map(line).join('\n')}` : '',
    interior.shown.length ? `Interior:\n${interior.shown.map(line).join('\n')}` : '',
    v.pick('col:note', [
      'Anything without a figure beside it is included.',
      'Anything with no price next to it comes as standard.',
      "Where there's no figure, it's included.",
    ]),
    andMore(rest, v, 'col:more', 'colours'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function describeOptions(result: Json, v: Voice): string {
  const options = list(result.options);
  if (options.length === 0) return 'That specification has no separate options. Everything is standard.';

  const standard = shortlist(options.filter((o) => o.included === true), 6);
  const extra = shortlist(options.filter((o) => o.included !== true), 6);

  const parts: string[] = [];
  if (extra.shown.length) {
    parts.push(
      `Available to add:\n${extra.shown
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
        `${standard.rest > 0 ? `, and ${standard.rest} more` : ''}.`,
    );
  }
  const more = andMore(extra.rest, v, 'opt:more', 'options');
  return [...parts, more].filter(Boolean).join('\n\n');
}

function describeFeatures(result: Json, v: Voice): string {
  const equipment = obj(result.standardEquipment);
  const categories = Object.entries(equipment);
  if (categories.length === 0) return "I don't have the equipment list for that specification.";

  // Three categories, five items each. A full standard-equipment list is forty
  // lines long and reads as a legal document; this reads as an answer.
  const { shown, rest } = shortlist(categories, 3);

  const lines = shown.map(([category, value]) => {
    const labels = shortlist((value as string[]) ?? [], 5);
    return (
      `**${category}**: ${sentenceList(labels.shown)}` +
      `${labels.rest > 0 ? `, and ${labels.rest} more` : ''}.`
    );
  });

  return [lines.join('\n\n'), andMore(rest, v, 'feat:more', 'categories')]
    .filter(Boolean)
    .join('\n\n');
}

function describePrice(result: Json): string {
  const lines = list(result.lines).map((l) => `- ${str(l.label)}: ${str(l.amount)}`);
  const total = money(result.total);

  return [
    str(result.summary) ? `**${str(result.summary)}**` : '',
    lines.join('\n'),
    total ? `**Total: ${total}**` : '',
    str(result.note),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function describeComparison(result: unknown): string {
  const models = list(result);
  if (models.length === 0) return 'I could not put those side by side.';

  const lines = models.map((m) => {
    const facts = [
      `from ${money(m.priceFrom)}`,
      num(m.maxHorsepower) ? `up to ${num(m.maxHorsepower)} hp` : '',
      (m.drivetrains as string[] | undefined)?.length
        ? sentenceList(m.drivetrains as string[])
        : '',
      num(m.bestElectricRangeKm) ? `up to ${num(m.bestElectricRangeKm)} km electric range` : '',
    ].filter(Boolean);
    return `- **${str(m.name)}**: ${facts.join(', ')}`;
  });

  return `${lines.join('\n')}\n\nTell me which matters most: space, pace or running cost. I'll narrow it down from there.`;
}

function describeStock(result: Json, v: Voice): string {
  const available = list(result.available);
  if (available.length === 0) {
    return v.pick('stock:none', [
      "Nothing matching that is on the ground right now. The team can tell you what's inbound and when.",
      "None of those here at the moment, sorry. The team will know what's on its way.",
      'Nothing like that in stock today. Someone here can tell you what is coming and roughly when.',
    ]);
  }

  const { shown, rest } = shortlist(available, 3);
  const lines = shown.map((unit) => {
    const colour = str(unit.exteriorColour);
    const delivery = str(unit.estimatedDelivery);
    return [
      `- **${str(unit.trim)}** ${str(unit.powertrain)}`,
      colour ? ` in ${colour}` : '',
      `, ${money(unit.price)}`,
      delivery ? `, available from ${delivery}` : '',
      ` (stock ${str(unit.stockNumber)})`,
    ].join('');
  });

  const lead =
    available.length === 1
      ? v.pick('stock:one', ['One is here now', 'There is one here now', 'We have one on the floor'])
      : v.pick('stock:many', [
          `${available.length} are here now`,
          `We have ${available.length} here now`,
          `${available.length} on the floor today`,
        ]);

  const caveat = v.pick('stock:caveat', [
    'Stock moves, so that is as of today.',
    "That's today. Stock does shift.",
    'Worth checking again if you leave it a few days; these move.',
  ]);

  return [`${lead}:`, lines.join('\n'), andMore(rest, v, 'stock:more', 'on site'), caveat]
    .filter(Boolean)
    .join('\n\n');
}

function describeEstimate(result: Json): string {
  return [
    `About **${str(result.monthlyPayment)} a month** over ${num(result.termMonths)} months at ${result.aprPercent}% APR.`,
    `Financed: ${str(result.amountFinanced)}. Total of payments: ${str(result.totalOfPayments)}.`,
    str(result.disclaimer),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function describeDealership(result: Json): string {
  const parts = [
    str(result.address) ? `We are at ${str(result.address)}.` : '',
    str(result.phone) ? `Phone ${str(result.phone)}.` : '',
    str(result.email) ? `Email ${str(result.email)}.` : '',
    num(result.salesResponseHours)
      ? `The sales team replies within ${num(result.salesResponseHours)} business hour(s).`
      : '',
  ];
  return parts.filter(Boolean).join(' ') || 'I do not have our contact details to hand.';
}

function describeHours(result: Json): string {
  const hours = list(result.hours);
  if (hours.length === 0) return 'I do not have our opening hours to hand.';

  const lines = hours.map((day) =>
    day.closed === true
      ? `- ${str(day.day)}: closed`
      : `- ${str(day.day)}: ${str(day.opens)} to ${str(day.closes)}`,
  );

  const closures = list(result.upcomingClosures).map(
    (c) => `- ${str(c.startsOn)}${str(c.endsOn) !== str(c.startsOn) ? ` to ${str(c.endsOn)}` : ''}: ${str(c.reason)}`,
  );

  return [
    `Our ${str(result.department)} hours (${str(result.timezone)}):`,
    lines.join('\n'),
    closures.length ? `Closed on:\n${closures.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function describeBooking(result: Json, v: Voice): string {
  const email = str(result.confirmationEmail) ?? '';
  return [
    `${v.pick('book:lead', ['Booked', "That's booked", 'All booked'])} for **${str(result.when)}**` +
      `${str(result.vehicle) ? ` in the ${str(result.vehicle)}` : ''}.`,
    `Your confirmation code is **${str(result.confirmationCode)}** and the reference is ${str(result.ticketNumber)}.`,
    // Queued is not delivered, and the wording travels with the fact.
    email.startsWith('queued')
      ? v.pick('book:email', [
          'A confirmation email is on its way.',
          'A confirmation is on its way to you by email.',
        ])
      : "I couldn't queue a confirmation email, so keep that code somewhere safe.",
    v.pick('book:close', [
      'See you then.',
      'Looking forward to it.',
      "We'll see you then.",
    ]),
  ].join(' ');
}

function describeCancellation(result: Json): string {
  return `Cancelled. That was ${str(result.was)}. The slot is free again, so say the word if you'd like another time.`;
}

function describeRequest(result: Json, next: string): string {
  const queued = str(result.confirmationEmail) === 'queued';
  return [
    `Done. Your reference is **${str(result.ticketNumber)}**.`,
    next,
    queued ? 'A confirmation email is on its way.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function describeHandoff(result: Json): string {
  return `I've passed this to a specialist. Your reference is **${str(result.ticketNumber)}**. They'll follow up; they haven't replied yet.`;
}

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
function describeRanking(result: Json, v: Voice): string {
  const models = list(result.models);
  const measure = str(result.measure);

  // Not enough to say. This is the popularity case, and it is the whole reason
  // the tool reports it separately: an ordering of two enquiries is not what
  // people are buying, and saying so costs nothing next to being wrong.
  if (result.enough === false || models.length === 0) {
    return v.pick('rank:none', [
      "I don't have enough to call that honestly. What I can do is order the range by price, power, electric range or fuel consumption. Any of those useful?",
      "Not enough behind that for me to give you a straight answer, and I'd rather not invent one. I can rank them on price, power, range or economy instead.",
      "I can't answer that one from anything I actually know. Price, power, electric range and fuel economy I can order for you. Say which.",
    ]);
  }

  const leader = models[0]!;
  const value = str(leader.value);

  const headline = value
    ? `The **${str(leader.name)}**, ${value}.`
    : `The **${str(leader.name)}**.`;

  const { shown, rest } = shortlist(models.slice(1), 3);
  const others = shown.map((model) => {
    const figure = str(model.value);
    return `- **${str(model.name)}**${figure ? `: ${figure}` : ''}`;
  });

  return [
    headline,
    measure ? `That's going on ${measure}.` : '',
    others.length ? `Then:\n${others.join('\n')}` : '',
    andMore(rest, v, 'rank:more', 'after that'),
  ]
    .filter(Boolean)
    .join('\n\n');
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
  if (trims.length === 0) return "I don't have the trim detail for that one.";

  const lines = trims.map((trim, index) => {
    const step = money(trim.stepUp);
    const kit = (trim.adds as string[] | undefined) ?? [];
    const more = num(trim.moreAdds) ?? 0;

    // The bottom rung adds nothing — there is nothing below it. Saying it
    // "adds" its standard kit reads as though the cheapest car were an upgrade.
    const verb = index === 0 ? 'Comes with' : 'Adds';
    const gained = kit.length
      ? ` ${verb} ${sentenceList(kit)}${more > 0 ? `, and ${more} more` : ''}.`
      : '';

    return `- **${str(trim.name)}**: from ${money(trim.priceFrom)}${step ? ` (${step} more than the one below)` : ''}.${gained}`;
  });

  const best = str(result.bestStepUp);
  const winner = best ? trims.find((trim) => str(trim.code) === best) : undefined;

  return [
    `The **${str(result.model)}** ladder, cheapest first:`,
    lines.join('\n'),
    winner
      ? `${v.pick('value:lead', [
          'Purely on the arithmetic',
          'If you go strictly on what you get for the money',
          'On paper, at least',
        ])}, the **${str(winner.name)}** is the step that earns its keep. It adds the most kit for what it costs. ${v.pick('value:caveat', [
          "Whether it's the right one for you is a different question, mind.",
          'That said, the one you want is the one with the kit you\'ll actually use.',
          "Worth saying that's arithmetic, not advice.",
        ])} Happy to go through any of them properly.`
      : "Honestly, none of the steps stands out on the numbers. It comes down to which kit you'd actually use. Tell me what matters to you and I'll tell you which one has it.",
  ]
    .filter(Boolean)
    .join('\n\n');
}
