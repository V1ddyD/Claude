# AI Tool Layer

The complete set of actions Claude is permitted to take. Nothing outside this list is
reachable from a conversation.

---

## The contract

```ts
type ToolContext = {
  tenantId: string;         // from hostname — never from the model
  conversationId: string;
  visitorId: string;
  customerId?: string;      // set only once the visitor has identified themselves
  requestId: string;
  now: Date;                // tenant-local, injected so time is testable
};

type ToolDefinition<I, O> = {
  name: string;
  scope: 'read' | 'write';
  summary: string;                       // becomes the Anthropic tool description
  input: ZodSchema<I>;                   // → JSON Schema for the API
  idempotent?: (i: I) => string;         // required for every write tool
  handler: (ctx: ToolContext, input: I) => Promise<O>;
  project: (o: O) => CustomerSafeDTO;    // explicit whitelist, never a raw row
};
```

Four invariants, enforced by the registry rather than by convention:

1. **No tool input may contain `tenantId`, `customerId`, `visitorId` or
   `conversationId`.** A registry-time assertion rejects any schema that declares them.
   The model has no vocabulary in which to request another dealership's data.
2. **Every `scope: 'write'` tool must define `idempotent`.** Registration fails
   otherwise.
3. **Every tool must define `project`.** No handler result reaches the model
   un-projected.
4. **No tool accepts free-form SQL, a filter DSL, a table name, a column name or a
   sort expression.** Every parameter is an enum, an id, a bounded number or a
   constrained string.

---

## Read tools

| Tool | Input | Returns | Row cap |
|---|---|---|---|
| `searchVehicles` | bodyStyle?, priceMax?, drivetrain?, powertrainKind?, seats?, keywords? | matching models: name, segment, price-from, headline specs | 6 |
| `getVehicle` | modelSlug | overview, price-from, body style, available powertrain and trim *names* | 1 |
| `getVehiclePowertrains` | modelSlug | powertrain name, kind, output, drivetrain, economy/range, price delta | 8 |
| `getVehicleTrims` | modelSlug, powertrainCode? | trim name, summary, price, key standard equipment | 8 |
| `getVehicleOptions` | modelSlug, trimCode, powertrainCode | options with price, marked standard/optional/unavailable | 20 |
| `getVehicleColours` | modelSlug, trimCode?, kind? | name, finish, hex, surcharge | 20 |
| `getVehicleFeatures` | modelSlug, trimCode | features by category | 30 |
| `calculateVehiclePrice` | modelSlug, powertrainCode, trimCode, exteriorColourCode?, interiorColourCode?, optionCodes[] | itemised breakdown and total; validates the combination is buildable | 1 |
| `compareVehicles` | modelSlugs[2..3], aspects[]? | side-by-side on requested aspects only | 3 |
| `checkInventory` | modelSlug, trimCode?, powertrainCode?, exteriorColourCode? | available units: stock number, colour, price, est. delivery. Reads `v_public_inventory` | 5 |
| `calculateFinanceEstimate` | priceCents, downPaymentCents, termMonths, aprBps? | monthly, total, interest — **always labelled an estimate** | 1 |
| `getFinancePrograms` | modelSlug? | configured programmes only; empty if none | 5 |
| `getDealershipInformation` | — | name, address, phone, email, services, response window | 1 |
| `getDealershipHours` | department? | opening hours and upcoming closures, tenant-local | 1 |
| `getAvailableTestDriveSlots` | modelSlug?, dateFrom, dateTo (≤14 days) | bookable start times with explicit date and timezone | 12 |

`calculateVehiclePrice` returns a typed `INVALID_COMBINATION` error when the requested
powertrain × trim isn't in `model_configurations`, or an option isn't available on it.
The assistant must then say the combination isn't offered — it may not price it anyway.

## Write tools

| Tool | Effect | Idempotency key |
|---|---|---|
| `upsertLead` | Create or update the lead for this conversation; attach signals | conversation |
| `createTestDrive` | Book an appointment inside one transaction: lead → appointment → resources → ticket → email outbox → staff notification → audit | conversation + slot |
| `cancelTestDrive` | Cancel an appointment the *current visitor* owns | appointment |
| `createCallbackRequest` | Callback ticket + notification | conversation + phone |
| `createSupportTicket` | Ticket of a given type | conversation + type + body hash |
| `createFinancingRequest` | Finance request + ticket. Never an approval | conversation |
| `createTradeInRequest` | Trade-in request + ticket. Never a valuation | conversation + vehicle |
| `requestHumanHandoff` | Flag the lead, notify the right role, tell the customer | conversation |
| `saveBuild` | Persist the current configuration with a price snapshot | conversation + build hash |
| `updateContactPreferences` | Record name, email, phone, consent | conversation |

### Tools that deliberately do not exist

| Not built | Why |
|---|---|
| `getCustomerProfile(email)` | Customer-data enumeration behind a chatbot. Profile access requires an authenticated session or a scoped magic link (Architecture §3). |
| any inventory status write | Only `inventory.status.write` holders change stock state. |
| any price write | Pricing is admin-configured. |
| `sendConfirmationEmail` | Email is a *consequence* of a committed transaction, enqueued by the service, never a thing the model chooses to do. Spec §9 lists it as a tool; this is the one place I depart from that list deliberately — a model-callable send is a model-callable spam button and can send mail for a transaction that rolled back. |
| `updateLead` (priority/status) | Priority is computed; status is owned by staff. |
| `assignLead` | Staffing is a human decision. |
| `getLeadConversation` | Internal. Spec §9 lists it as a customer tool; it belongs to the staff AI surface only. |
| anything delete | Nothing the assistant touches is destructive. |

The last three rows are departures from the tool list in spec §9, each because the tool
as named would breach a rule stated elsewhere in the same spec (§52 no direct writes,
§54 never expose internal priority, §21 never claim an email was sent). Flagged rather
than silently dropped.

---

## Projection: the leak boundary

Every tool result passes through a hand-written DTO before entering the model's context.
This layer is small, explicit and unit-tested, because it is the only place internal data
could reach a customer.

Never projected, at any time: cost or margin, floorplan age, days in stock, internal
notes, lead priority or score, AI summaries, staff identity beyond a first name, other
customers, other tenants, raw ids beyond opaque public references, email delivery logs,
audit rows.

```ts
// inventory: what the model may see
{ stockNumber: 'SIN-0142', exteriorColour: 'Obsidian Black',
  interiorColour: 'Charcoal', price: '$58,900', priceCents: 5890000,
  estimatedDelivery: '2026-10-03', asOf: '2026-09-11T14:19:00-04:00' }
// never: acquisitionCostCents, daysInStock, reservedForCustomerId, internalNotes
```

Money is returned both formatted and as minor units: the formatted string is what the
model should quote, the integer prevents it from doing arithmetic on a decimal.

---

## The conversation loop

```
customer message
  → rate limit (visitor, IP, tenant token budget)
  → load window: system prompt + catalogue digest + pinned facts + last N turns
  → Claude
      ↳ tool_use → registry.dispatch → validate → handler → project → tool_result
      ↳ repeat, bounded: ≤ 6 tool calls, ≤ 30 s, ≤ 1 write tool per turn
  → stream reply
  → persist messages + token counts
  → enqueue extract_and_score      ← Pass B, off the hot path
```

The one-write-per-turn bound is deliberate: no single customer message should be able to
create a lead, a ticket, an appointment and a trade-in request at once. A genuine
multi-step request takes multiple turns, which is also how a human would handle it.

---

## Grounding rules in the system prompt

Stated as rules, enforced by evaluation:

- State a spec, price, availability, slot or dealership fact **only** from a tool result
  in this turn. Otherwise: say you don't have it confirmed, and offer the team.
- Answer the question asked. Do not enumerate the catalogue.
- Never state that a booking, ticket or email succeeded before the tool returns success.
- Finance output is an estimate, never an offer. Trade-in output is never a valuation.
- Never promise a specific vehicle without a `checkInventory` hit this turn.
- Never mention internal handling, priority, scoring, staff names or system internals.
- When a tool returns `INVALID_COMBINATION`, `SLOT_TAKEN` or `NOT_FOUND`, say so plainly
  and offer the alternatives the tool returned.
- Ask one clarifying question when a detail is genuinely ambiguous. Don't interrogate.

---

## Failure behaviour

| Failure | Customer sees | System does |
|---|---|---|
| Tool throws | "Let me get someone to confirm that for you." | log with request id; offer handoff |
| `SLOT_TAKEN` | "That time just went — I have 10:00, 13:30 or 15:00." | return alternatives from the same query |
| `INVALID_COMBINATION` | "That trim isn't offered with that engine — here's what is." | return valid combinations |
| No credential configured | The rule-based assistant answers, on the same tools | nothing — this is a supported mode |
| Model API down | Chat degrades to a contact form; catalogue still browsable | alert; no lost enquiry |
| Token budget exhausted | Falls back to the rule-based assistant | notify tenant admin |
| Extraction job fails | Nothing — conversation is unaffected | retry with backoff; dead-letter visible to admins |
| DB unavailable during write | "I couldn't save that just now — try again in a moment." | no partial record; transaction rolled back |

The assistant never invents a fallback answer, and never implies a human has already
replied when one has not.

---

## Evaluation

Three ways to run one corpus, measuring three different things:

| | `npm run eval` | `npm run eval:rules` | `npm run eval:live` |
|---|---|---|---|
| Who chooses the tools | the case | the rule-based assistant | the model |
| What it measures | the system | the assistant that ships today | the model's judgement |
| Needs a key | no | no | yes |
| Costs | nothing | nothing | ~$0.34, capped at $2.00 |

In `rules` mode the positive expectations — which tool, which error code, which priority
band — are reported as notes rather than failures, because they describe how a *model* is
expected to reach an answer and the rule-based assistant legitimately reaches some of
them another way. Asked about a car we do not build, it answers from the catalogue digest
instead of calling a tool and being refused; asked to price a trim and engine that are
not offered together, it says so from the compatibility matrix it already fetched rather
than letting the price tool refuse.

The safety expectations are never downgraded. A tool that must not be called, a phrase
that must not appear in a reply, internal data that must not reach the assistant's
context — those fail in every mode. So a green `rules` run is a claim about what the
assistant did not say, and nothing more.

The corpus itself, run on every prompt, rule or model change:

- **Intent** — expected classification per turn.
- **Tool choice** — expected calls and arguments; flags both unnecessary calls and
  answers given with no call at all (the hallucination signature).
- **Extraction** — expected `LeadSignals` diffed field by field.
- **Priority** — expected band, with the §11 examples as the anchor cases.
- **Negative grounding** — ask for a nonexistent model, a colour that isn't offered, a
  trim/engine pairing that isn't built, a slot outside opening hours. Assert the reply
  declines rather than invents. These are the tests that matter most.
- **Leakage** — adversarial prompts asking for internal priority, other customers, staff
  notes or system instructions. Assert refusal and no internal token in the output.


---

## What the rule-based assistant reaches

`src/server/ai/rule-based/` implements the same `ModelClient` interface and calls the
same registry. It reaches twenty of the twenty-two tools. Nothing is special-cased for
it: the four startup invariants, the schema validation, the savepoint per dispatch and
the idempotency replay all apply exactly as they do to the model.

Two it never calls, and the reason is the same in both cases — there is no conversation
in its script that would produce the input:

| Tool | Why not |
|---|---|
| `saveBuild` | Saving a specification presupposes having configured one, which is a back-and-forth about options that pattern matching cannot hold. |
| `updateContactPreferences` | Contact details reach the record through the write tools themselves, which take them as arguments and record them at full confidence. |

Both remain reachable the moment a model is configured. They are not dead code and not
a gap in the tool surface — they are a gap in one caller.

### Extraction

Pass B is skipped entirely when the rule-based assistant is running (`skipped:
'no-model'`). Reading a transcript for implied budget and timeframe is inference, and
inference is the thing it does not do. Lead scoring still runs: the write tools record
name, email, chosen model and intent signals at confidence 1 with source `form`, which
is evidence the system observed rather than guessed — so a booked test drive still
produces a scored, prioritised lead in the portal.
