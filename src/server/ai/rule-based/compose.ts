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
      return describeOptions(result);
    case 'getVehicleFeatures':
      return describeFeatures(result);
    case 'calculateVehiclePrice':
      return describePrice(result);
    case 'compareVehicles':
      return describeComparison(step.result);
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
        'That books an appraisal, not a valuation — what your car is worth needs an in-person look.',
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

  const lines = models.map((model) => {
    const tagline = str(model.tagline);
    return `- **${str(model.name)}** — ${str(model.segment)}, from ${money(model.priceFrom)}${tagline ? `. ${tagline}` : ''}`;
  });

  const lead =
    models.length === 1
      ? v.pick('search:one', ['One car fits that', 'Just the one fits that', 'One of ours fits that'])
      : v.pick('search:many', [
          `${models.length} fit that`,
          `${models.length} of ours fit that`,
          `That narrows it to ${models.length}`,
        ]);

  return `${lead}:\n\n${lines.join('\n')}`;
}

function describeVehicle(result: Json, v: Voice): string {
  // getVehicle projects these as plain names, not objects.
  const powertrains = (result.powertrains as string[] | undefined) ?? [];
  const trims = (result.trims as string[] | undefined) ?? [];
  const overview = str(result.overview);

  const parts = [
    `**${str(result.name)}** — ${str(result.segment)}, from ${money(result.priceFrom)}.`,
    overview,
    powertrains.length ? `Powertrains: ${sentenceList(powertrains)}.` : '',
    trims.length ? `Trims: ${sentenceList(trims)}.` : '',
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

  const lines = powertrains.map((pt) => {
    const facts = [
      num(pt.horsepower) ? `${num(pt.horsepower)} hp` : '',
      str(pt.drivetrain),
      num(pt.electricRangeKm) ? `${num(pt.electricRangeKm)} km range` : '',
    ].filter(Boolean);
    return `- **${str(pt.name)}** — ${facts.join(', ')}`;
  });

  return `${lines.join('\n')}`;
}

function describeTrims(result: Json, v: Voice): string {
  const trims = list(result.trims);
  if (trims.length === 0) {
    return v.pick('trim:none', [
      "I don't have the trim detail for that one.",
      "I haven't got the trim levels for that car.",
    ]);
  }
  return trims.map((t) => `- **${str(t.name)}** — from ${money(t.priceFrom)}`).join('\n');
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
    return `- **${str(c.name)}**${finish ? ` (${finish})` : ''}${surcharge ? ` — ${surcharge}` : ''}`;
  };

  // Kept apart. A paint and a leather in one list reads as nine paints, three
  // of which the customer would be surprised to find on the outside of the car.
  const exterior = colours.filter((c) => c.kind !== 'interior').map(line);
  const interior = colours.filter((c) => c.kind === 'interior').map(line);

  return [
    exterior.length ? `Paint:\n${exterior.join('\n')}` : '',
    interior.length ? `Interior:\n${interior.join('\n')}` : '',
    v.pick('col:note', [
      'Anything without a figure beside it is included.',
      'Anything with no price next to it comes as standard.',
      "Where there's no figure, it's included.",
    ]),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function describeOptions(result: Json): string {
  const options = list(result.options);
  if (options.length === 0) return 'That specification has no separate options — everything is standard.';

  const standard = options.filter((o) => o.included === true);
  const extra = options.filter((o) => o.included !== true);

  const parts: string[] = [];
  if (extra.length) {
    parts.push(
      `Available to add:\n${extra.map((o) => `- **${str(o.name)}** — ${money(o.price) ?? 'price on request'}`).join('\n')}`,
    );
  }
  if (standard.length) {
    parts.push(`Already included at this trim: ${sentenceList(standard.map((o) => str(o.name) ?? ''))}.`);
  }
  return parts.join('\n\n');
}

function describeFeatures(result: Json): string {
  const equipment = obj(result.standardEquipment);
  const categories = Object.entries(equipment);
  if (categories.length === 0) return 'I do not have the equipment list for that specification.';

  return categories
    .map(([category, labels]) => `**${category}**: ${sentenceList((labels as string[]) ?? [])}.`)
    .join('\n\n');
}

function describePrice(result: Json): string {
  const lines = list(result.lines).map((l) => `- ${str(l.label)} — ${str(l.amount)}`);
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
    return `- **${str(m.name)}** — ${facts.join(', ')}`;
  });

  return `${lines.join('\n')}\n\nTell me which matters most — space, pace or running cost — and I will narrow it down.`;
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

  const lines = available.map((unit) => {
    const colour = str(unit.exteriorColour);
    const delivery = str(unit.estimatedDelivery);
    return [
      `- **${str(unit.trim)}** ${str(unit.powertrain)}`,
      colour ? ` in ${colour}` : '',
      ` — ${money(unit.price)}`,
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
    "That's today — stock does shift.",
    'Worth checking again if you leave it a few days; these move.',
  ]);

  return `${lead}:\n\n${lines.join('\n')}\n\n${caveat}`;
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
      ? `- ${str(day.day)} — closed`
      : `- ${str(day.day)} — ${str(day.opens)} to ${str(day.closes)}`,
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
    `${v.pick('book:lead', ['Booked', "That's booked", 'All booked'])} — **${str(result.when)}**` +
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
  return `Cancelled — that was ${str(result.was)}. The slot is free again, so say the word if you'd like another time.`;
}

function describeRequest(result: Json, next: string): string {
  const queued = str(result.confirmationEmail) === 'queued';
  return [
    `Done — your reference is **${str(result.ticketNumber)}**.`,
    next,
    queued ? 'A confirmation email is on its way.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function describeHandoff(result: Json): string {
  return `I have passed this to a specialist — your reference is **${str(result.ticketNumber)}**. They will follow up; they have not replied yet.`;
}
