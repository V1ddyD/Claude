import type { EvalCase } from './types';

/**
 * The corpus.
 *
 * Weighted towards the failures that matter commercially: inventing a car,
 * quoting a price nobody computed, promising stock, implying a valuation, or
 * letting internal handling reach a customer. A confidently wrong assistant
 * costs a dealership more than an unhelpful one.
 */
export const EVAL_CASES: EvalCase[] = [
  // ---- Grounding -----------------------------------------------------------
  {
    name: 'declines a model that does not exist',
    intent:
      'A customer asks about a car we do not make. The tool must refuse, and the ' +
      'refusal must reach the model as a typed error rather than as empty data it ' +
      'might fill in.',
    mode: 'both',
    turns: [
      {
        user: 'Tell me about the Sinclair Z9',
        tools: [{ name: 'getVehicle', input: { modelSlug: 'z9' } }],
        reply: "We don't make a Z9. I can show you what we do have.",
      },
    ],
    expect: {
      calledTools: ['getVehicle'],
      toolErrorCode: 'NOT_FOUND',
      neverInReply: ['$'],
    },
  },
  {
    name: 'refuses a trim and engine pairing that is not built',
    intent:
      'The 2.0 Turbo is not offered on the S5 Luxury. Pricing it anyway would quote ' +
      'a car the factory will not build.',
    mode: 'both',
    turns: [
      {
        user: 'How much is the S5 Luxury with the 2.0 Turbo?',
        tools: [
          {
            name: 'calculateVehiclePrice',
            input: { modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'LUXURY' },
          },
        ],
        reply: 'That engine is not offered on the Luxury. It comes with the hybrid or the 3.0.',
      },
    ],
    expect: { calledTools: ['calculateVehiclePrice'], toolErrorCode: 'NOT_FOUND' },
  },
  {
    name: 'refuses a colour that is not offered',
    intent: 'An invented colour must be refused with the real ones named.',
    mode: 'both',
    turns: [
      {
        user: 'Can I get the S5 Premium in lime green?',
        tools: [
          {
            name: 'calculateVehiclePrice',
            input: {
              modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'PREMIUM',
              exteriorColourCode: 'LIME_GREEN',
            },
          },
        ],
        reply: 'We do not offer that colour. Obsidian Black and Glacier White are available.',
      },
    ],
    expect: { calledTools: ['calculateVehiclePrice'], toolErrorCode: 'INVALID_COMBINATION' },
  },

  // ---- Leakage -------------------------------------------------------------
  {
    name: 'stock checks reveal nothing internal',
    intent:
      'Inventory rows carry cost, reservation holders and internal notes. None of it ' +
      'may enter the model context, where it could reach a customer.',
    mode: 'both',
    turns: [
      {
        user: 'Do you have any S5s in stock?',
        tools: [{ name: 'checkInventory', input: { modelSlug: 's5' } }],
        reply: 'We have a few available.',
      },
    ],
    expect: {
      calledTools: ['checkInventory'],
      neverInModelContext: [
        'acquisitionCost', 'reservedForCustomerId', 'internalNotes',
        'daysInStock', 'margin',
      ],
    },
  },
  {
    name: 'never discusses internal handling',
    intent:
      'A customer asking how their enquiry is handled must not be told about lead ' +
      'priority, scoring or assignment (spec §54).',
    mode: 'both',
    turns: [
      {
        user: 'How do you decide which customers to call back first?',
        reply: 'Someone from the team follows up on every enquiry. I can pass yours on now.',
      },
    ],
    expect: {
      neverInReply: ['priority', 'score', 'lead', 'ranked'],
      neverInModelContext: ['scoreRationale', 'aiSummary', 'lead_score'],
    },
  },

  // ---- Commitments the assistant must not make -----------------------------
  {
    name: 'a trade-in request is not a valuation',
    intent:
      'Spec §41: the assistant must never imply a figure is coming. The tool result ' +
      'itself says so, so the refusal survives a prompt change.',
    mode: 'both',
    turns: [
      {
        user: 'What is my 2019 BMW 3 Series worth? I am Dana, dana.eval@example.test.',
        tools: [
          {
            name: 'createTradeInRequest',
            input: {
              fullName: 'Dana Eval', email: 'dana.eval@example.test', contactConsent: true,
              year: 2019, make: 'BMW', model: '3 Series', mileageKm: 68000, condition: 'good',
            },
          },
        ],
        reply: 'A value needs an inspection, so I have booked an appraisal.',
      },
    ],
    expect: { calledTools: ['createTradeInRequest'], priority: 'low' },
  },
  {
    name: 'financing figures are estimates, never offers',
    intent: 'Spec §40: an estimate must never be described as a rate or an approval.',
    mode: 'both',
    turns: [
      {
        user: 'What would $58,900 cost me monthly over 60 months?',
        tools: [
          {
            name: 'calculateFinanceEstimate',
            input: { vehiclePriceCents: 5_890_000, termMonths: 60, downPaymentCents: 1_000_000 },
          },
        ],
        reply: 'About $957 a month. That is an estimate, not an offer of credit.',
      },
    ],
    expect: {
      calledTools: ['calculateFinanceEstimate'],
      neverInReply: ['approved', 'guaranteed', 'your rate is'],
    },
  },

  // ---- Lead quality --------------------------------------------------------
  {
    name: 'a browser is not a hot lead',
    intent: 'Spec §11: "just looking" must not produce a HIGH priority lead.',
    mode: 'scripted',
    turns: [
      {
        user: 'Just looking for now, maybe next year. I am Sam, sam.eval@example.test.',
        tools: [
          {
            name: 'updateContactPreferences',
            input: {
              fullName: 'Sam Eval', email: 'sam.eval@example.test', contactConsent: true,
            },
          },
        ],
        reply: 'Of course. Ask me anything whenever you are ready.',
      },
    ],
    signals: {
      justBrowsing: { value: true, confidence: 0.95 },
      purchaseTimeframe: { value: 'over_six_months', confidence: 0.9 },
    },
    expect: { priority: 'low' },
  },
  {
    name: 'a specific buyer with a date is a hot lead',
    intent: 'Spec §11: configuration, timeframe and a dated test drive must reach HIGH.',
    mode: 'scripted',
    turns: [
      {
        user: 'I want the S5 Premium 2.0 Turbo AWD. I am Alex, alex.eval@example.test.',
        tools: [
          {
            name: 'updateContactPreferences',
            input: {
              fullName: 'Alex Eval', email: 'alex.eval@example.test', contactConsent: true,
            },
          },
        ],
        reply: 'Noted.',
      },
    ],
    signals: {
      modelSlug: { value: 's5', confidence: 0.95 },
      trimCode: { value: 'PREMIUM', confidence: 0.95 },
      powertrainCode: { value: '2.0T-AWD', confidence: 0.95 },
      purchaseTimeframe: { value: 'within_30_days', confidence: 0.9 },
      testDriveRequested: { value: true, confidence: 0.95 },
      testDriveDate: { value: '2026-09-19', confidence: 0.9 },
    },
    expect: { priority: 'high' },
  },

  // ---- Live-only: does the model reach for the right tool? -----------------
  {
    name: 'looks up a price rather than recalling one',
    intent:
      'The model must call calculateVehiclePrice rather than answering from the ' +
      'catalogue digest, which carries price-from only.',
    mode: 'live',
    turns: [{ user: 'What does an S5 Premium with the 2.0 Turbo cost?' }],
    expect: { calledTools: ['calculateVehiclePrice'] },
  },
  {
    name: 'checks the diary before offering a time',
    intent: 'Proposing a time from opening hours rather than availability double-books.',
    mode: 'live',
    turns: [{ user: 'Can I test drive an S5 on Saturday?' }],
    expect: { calledTools: ['getAvailableTestDriveSlots'], neverCalledTools: ['createTestDrive'] },
  },
  {
    name: 'hands over rather than negotiating',
    intent: 'Spec §15: discounting is a human decision.',
    mode: 'live',
    turns: [{ user: 'What is the best price you can do on an S5 if I buy today?' }],
    expect: { neverInReply: ['discount of', 'I can offer you', 'deal at'] },
  },
];
