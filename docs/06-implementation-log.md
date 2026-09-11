# Implementation Log

What is actually built and verified, milestone by milestone. Kept honest on
purpose: a claim here should be checkable by running something.

---

## M0 — Architecture ✅

Design documents, schema, tool contracts, spec review. No application code.

**Verified:** the schema applies to PostgreSQL 16, and `db/validate/` proves the
overlap, cross-tenant, RLS and append-only guarantees.

**Defect found by building it:** `audit_logs` used `bigserial`, which needs a separate
sequence grant the application role did not have — audit writes would have failed at
the moment they mattered most. Changed to `GENERATED ALWAYS AS IDENTITY`.

---

## M1 — Foundation ✅

Spec phases 2–4: database, backend skeleton, authentication and permissions.

### Built

| Area | Where |
|---|---|
| Migration runner, forward-only, checksum-pinned | `src/server/db/migrate.ts` |
| Schema + RLS + roles + seeded matrices | `db/migrations/0001`, `0002` |
| Tenant-scoped transactions | `src/server/db/tenant-db.ts` |
| Connection pool, split by privilege | `src/server/db/client.ts` |
| Validated environment | `src/server/config/env.ts` |
| Typed domain errors | `src/server/errors.ts` |
| Permission matrix | `src/server/auth/permissions.ts` |
| Authorization guard | `src/server/auth/require-staff.ts` |
| Session adapters (Supabase + development) | `src/server/auth/session.ts` |
| Tenant resolution by hostname | `src/server/context/tenant.ts` |
| Audit logging | `src/server/services/audit/` |
| Portal shell, sign-in, dashboard | `src/app/(portal)/` |
| Layering rules as lint | `eslint.config.mjs` |
| CI, including a client-bundle secret scan | `.github/workflows/ci.yml` |

### Verified

36 tests against a real PostgreSQL 16, run as the unprivileged request-path role:

- **Isolation (15).** Reads scoped to context; another tenant's rows invisible;
  **no context returns zero rows, not everything**; cross-tenant writes, updates and
  deletes all rejected; the sign-in lookup returns the caller's own row and cannot
  enumerate colleagues; `audit_logs` refuses `UPDATE` and `DELETE`; and — the
  assertion the rest depend on — the app role is neither owner, superuser, nor
  `BYPASSRLS`.
- **Permissions (8).** The code matrix and the database matrix agree exactly; sales
  cannot reach pricing, settings, audit or assignment; sales and service tickets stay
  separate; managers cannot escalate a manager or an admin.
- **Route guards (4).** Every portal route authorizes itself; sign-in is the only
  public one; no route accepts a tenant id from its params.
- **Schema parity (2).** Drizzle definitions match `information_schema`, including
  nullability.
- **Errors and audit (7).** Internal detail never reaches a public error shape;
  forbidden is worded so it cannot confirm a record exists; audit diffs record only
  real changes.

Demonstrated end to end in a running app: a SALES account sees Dashboard and "your
assigned leads"; an ADMIN additionally sees Analytics and Settings and "all dealership
leads"; and the same code serves a second tenant, Northwind, with its own brand and
staff — no code change, only rows.

### Three things building it changed

1. **RLS blocked the development sign-in picker**, which tried to list staff accounts
   through the request-path role. That is correct: `staff_users` is scoped so the
   application cannot enumerate a dealership's employees. Listing staff is a
   *directory* operation, so it moved to `src/server/auth/dev-directory.ts`, which uses
   the owner connection, is refused in production, and is disabled the moment a real
   identity provider is configured — the same privileged position Supabase occupies.
   Worth noting as evidence the policy is load-bearing rather than decorative.

2. **`typedRoutes` caught the portal linking to pages that do not exist.** Rather than
   loosening it, unbuilt sections now render as disabled with the milestone they
   arrive in. Spec §60 in practice: the navigation tells the truth about what works.

3. **Environment validation and the connection pool became lazy.** Both ran at import
   time, which made `next build` require a reachable database and production secrets.
   Validation now happens on first use — still at the first request, so a misconfigured
   deployment fails immediately, but a build no longer needs credentials it has no
   business holding.

### Deliberately not built

- **Catalogue, lead, conversation, appointment and ticket Drizzle definitions.** The
  tables exist in migration 0001. Definitions are added as each is first queried, so
  `tests/schema` can check them against the real database — an unverified definition is
  surface, not progress.
- **Dashboard figures.** The panels spec §23 calls for are present and empty, labelled
  with the milestone that fills them. Fabricated counts would make the portal look
  finished while telling staff nothing true.

---

## M2 — Catalogue and pricing ✅

Spec phase 5. The catalogue, the configurator's rules, and inventory state.

### Built

| Area | Where |
|---|---|
| Catalogue and inventory schema definitions | `src/server/db/schema/catalogue.ts`, `inventory.ts` |
| Pricing engine (pure, no database) | `src/server/services/pricing/` |
| Catalogue repository | `src/server/db/repositories/catalogue.ts` |
| Catalogue and pricing use cases | `src/server/services/catalogue/` |
| Inventory state machine | `src/server/services/inventory/` |
| Sinclair catalogue seed | `db/seeds/catalogue/` |
| Inventory seed (deterministic) | `db/seeds/inventory.ts` |
| Database reset for re-seeding | `db/seeds/reset.ts` |

Seeded: **10 models, 36 configurations, 51 options, 86 inventory units.**

### The decision that shapes the configurator

`model_configurations.price_cents` is authoritative for a combination; the powertrain
and trim deltas are how that price is *explained* to a customer. Two representations of
one number drift, so the pricing engine asserts `base + powertrain + trim = configuration
price` on every quote and refuses to price when they disagree — the customer sees a
neutral "temporarily unavailable", the detail goes to the log. An integration test
asserts the same identity across all 36 configurations, so the failure is caught in CI
rather than at a quote.

Seed data never writes a configuration price by hand: it is computed from the same three
numbers. The invariant cannot be violated by a typo, only by a deliberate edit.

### Matrix, not cartesian product

The S5's 2.0 Turbo is offered on Core and Premium but not Luxury; the inline-six is
offered on Premium and Luxury but not Core. A test asserts that at least one model
restricts its matrix, because a catalogue where every trim takes every engine is a price
calculator wearing a configurator's clothes.

Options carry the same asymmetry: the Technology Package is standard on S5 Premium
(charged at zero, shown as "Included") and $3,200 on Core. Dependencies are real —
Comfort requires Technology, Towing excludes the Panoramic Roof — and enforced by the
engine with the valid alternatives attached to the error, so the caller can offer them
rather than only refuse.

### Verified

87 tests, up from 36. New:

- **Pricing (12, pure).** Itemisation, colour and option pricing, standard equipment
  never charged, order-independence and duplicate handling; refusal of unbuildable
  configurations, unavailable colours, unknown options, and both rule kinds; unknown
  options reported *before* dependency failures, so a misspelling is not reported as a
  conflict; and the deltas-disagree case, asserting the internal detail stays internal.
- **Catalogue (17, real database).** No model has fewer than two powertrains or trims;
  the matrix genuinely restricts; every configuration prices to its deltas exactly; no
  zero-priced configurations; no option both standard and surcharged; option rules never
  cross models; the public inventory view shows only available units and there is
  genuinely hidden stock behind it; every demonstrator is a bookable resource; and the
  whole catalogue is invisible to the second tenant.
- **Inventory (10, real database).** `available → reserved → sold` permitted;
  `available → sold` refused because no row permits it; a sold car cannot return to
  available; reserving without an expiry refused; re-sending a transition is idempotent;
  a salesperson is refused and the car does not move; a stale version is rejected; every
  move is audited with before and after; lapsed holds return to the market.
- **Pricing service (12, end to end).** The §44 demonstration quote comes out at
  $58,900; **every one of the 36 configurations prices without error and matches its
  stored price.**

### Two things building it changed

1. **The schema said a plug-in hybrid was impossible.** Migration 0001 asserted
   `(kind = 'bev') = (battery_kwh IS NOT NULL)`, so the S7 3.0 Plug-in Hybrid — a
   battery *and* an engine — was rejected on insert. Migrations are immutable by design,
   so `0003` replaces the constraint with the correct rule and adds one requiring a BEV
   to declare its range. Found by seeding real data, which is the point of seeding real
   data.

2. **The test harness was seeding less than the tests assumed.** The catalogue suite
   passed against rows left behind by a manual seed, and would have failed in CI on a
   clean database. The harness now seeds the catalogue, and the whole suite is verified
   from an empty database. Worth stating because a test that passes for the wrong reason
   is worse than one that fails.

### Deliberately not built

- **Customer-facing catalogue pages.** M4. The service layer is complete and tested;
  rendering it is a separate concern and the site deserves its own design pass.
- **`saved_builds` writes.** The table and the price snapshot shape exist, but nothing
  saves a build until the configurator does in M4.
- **Vehicle imagery.** `hero_image_url` is null throughout. Per the M0 decision, renders
  arrive incrementally, so no page may assume an image exists — the placeholder is the
  default state, not an error state.

---

## M3 — The walking skeleton ✅

The reordering proposed in `docs/04-spec-review.md` §17: prove the AI -> lead -> portal
spine before building the surfaces on top of it.

### Built

| Area | Where |
|---|---|
| Tool registry, invariants enforced at startup | `src/server/ai/tools/registry.ts` |
| Eight read tools + one write tool | `src/server/ai/tools/read/`, `write/` |
| Projection layer (the leak boundary) | `src/server/ai/tools/projections/` |
| Model client, behind an interface | `src/server/ai/client.ts` |
| Conversation loop (Pass A) | `src/server/ai/conversation.ts` |
| Extraction and scoring (Pass B) | `src/server/ai/extraction.ts` |
| Lead signals schema + rule engine | `src/server/services/scoring/` |
| Lead lifecycle | `src/server/services/leads/` |
| Slot computation and booking | `src/server/services/booking/` |
| Ticket numbering | `src/server/services/tickets/numbering.ts` |
| Visitor identity | `src/server/services/visitors.ts` |
| Job queue and worker | `src/server/jobs/` |
| Chat and cron endpoints | `src/app/api/chat/`, `api/cron/worker/` |
| Leads list and detail | `src/app/(portal)/portal/(dashboard)/leads/` |

### Verified

162 tests, up from 87. The exit criterion — spec §44 end to end — passes: a customer
describes an SUV around $50,000, asks what engines the S5 has, picks the 2.0 Turbo AWD in
Premium, is quoted **$58,900** computed from the catalogue, books a test drive, and a
salesperson opening the portal sees the customer, the exact configuration, the budget,
the timeframe, the trade-in, the appointment, the ticket number and the whole
conversation — priority **HIGH**, with a rationale built from the rules that fired.

Also asserted: the model may not name a tenant or a customer (identity is never a tool
parameter); no tool exposes a query surface; every write tool declares idempotency and a
retried booking returns the first result; one write per customer message; the tool loop
is bounded; a failed tool leaves nothing behind; internal fields never enter the model's
context; the assistant degrades honestly when the model is unavailable; extraction
discards output that does not validate rather than coercing it; and the three §11 anchor
conversations score LOW, MEDIUM and HIGH.

### Four bugs the tests found

1. **A failed write tool left partial records committed.** The conversation shares one
   transaction and `dispatch` catches tool errors rather than throwing, so a booking that
   failed after creating the customer and lead left both behind — a lead with no
   appointment, exactly what spec §33 forbids. Each tool now runs inside a **savepoint**;
   a failure rolls back its writes while the conversation survives. Regression test in
   `tests/integration/conversation.test.ts`.

2. **Constraint violations were invisible.** `pgErrorCode` read `code` off the thrown
   error, but the query builder wraps the driver's error — so the exclusion violation was
   never recognised and a customer losing a race for a slot would have seen a raw
   database error instead of "that time has just gone". It now walks the `cause` chain.

3. **`orderBy` slipped past the tool-input guard.** The check lowercased the field name
   and compared it against a list containing `orderBy`, so it never matched. Both sides
   are lowercased now. The guard had a hole in exactly the field most likely to be added.

4. **Scoring mis-weighted two real cases.** Naming a model scored nothing, so the spec's
   MEDIUM example came out LOW; and both test-drive rules fired together, double-counting
   one fact and saying it twice in the rationale. Added a `model_identified` rule and rule
   **supersession**, so a specific rule replaces the general one it covers.

Plus two of my own test bugs worth noting, because both looked like product failures:
a booking window 16 days out (beyond the dealership's 14-day horizon) and a concurrency
case that used a transition the state machine forbids anyway.

### Two things building it changed

1. **Nothing created the anonymous visitor.** A conversation references a visitor row and
   the foreign key refused — correctly. The central flow is a stranger opening the chat,
   so there has to be something to attach a conversation to before anyone gives a name.
   `src/server/services/visitors.ts` now mints one, and treats a cookie naming an unknown
   visitor as untrusted rather than creating that id.

2. **The seed did not guarantee a demonstrator per model.** Demo cars were assigned by the
   random status mix, so some models had none and a customer asking to drive one was
   refused outright. A dealership can demonstrate everything it sells; the seed now
   guarantees one per model.

### What is NOT verified

**No live model call has been made.** No `ANTHROPIC_API_KEY` is configured in this
environment, so the Anthropic client is written against the current API (`claude-opus-5`,
adaptive thinking, `output_config.effort`, prompt-cached system prefix) but **has never
run**. Everything around it — dispatch, grounding, persistence, idempotency, savepoints,
extraction, scoring, the portal — is exercised by a scripted model, which is the right
way to test our behaviour rather than a model's phrasing. Before a demo: set the key and
walk the §44 conversation by hand. Expect prompt iteration; expect nothing structural to
move.

### Deliberately not built

- **The customer-facing chat UI.** The endpoint works and is tested; the interface is M4,
  with the rest of the site.
- **Email delivery.** Messages are queued in the outbox with the right status; the Resend
  provider and its webhooks are M4.
- **Follow-up rules, assignment, status transitions from the portal.** M5.

---

## M4 — The assistant ✅

**Reprioritised.** The chatbot is the product; the website is the environment it is
tested in. M4 was rescoped around the assistant's capability surface rather than around
the site, and the site got the smallest treatment that makes it a credible testbed.

### Built

| Area | Where |
|---|---|
| 22 tools, from 9 | `src/server/ai/tools/` |
| Finance estimator (pure) | `src/server/services/finance/` |
| One path for every customer request | `src/server/services/tickets/index.ts` |
| Conversation memory — pinned facts | `src/server/ai/context.ts` |
| The assistant interface | `src/components/site/assistant.tsx` |
| Confirmation slip (§21) | `src/components/site/confirmation-slip.tsx` |
| Email provider, templates, outbox drain | `src/server/services/email/` |
| Delivery webhook | `src/app/api/webhooks/email/` |
| Control-plane tenant enumeration | `src/server/db/control-plane.ts` |
| Site: home, models, model detail | `src/app/(site)/` |

**The tool set.** Catalogue (search, model, powertrains, trims, colours, options,
features, price, compare, inventory), advice (finance estimate, dealership information,
hours, test drive slots) and actions (contact details, save build, test drive, callback,
enquiry, trade-in, financing, human handoff). Every write tool requires explicit
`contactConsent: true` — a literal in the schema, so it cannot be called without it.

**Nothing promises an outcome.** A trade-in request returns
`valuation: 'none — a trade-in value requires an in-person inspection'`; a financing
request returns `approval: 'none — a specialist reviews financing and confirms terms'`;
a handoff returns `'A specialist has been notified and will follow up. They have NOT
replied yet.'` The refusal is in the data the model reads, not only in the prompt.

**Memory.** Pinned facts are assembled from the lead's structured signals plus the
subject of recent tool calls, so "how much is the Premium?" resolves to the car the
customer is looking at and nobody is asked for their budget twice. Contact details and
internal state are deliberately never pinned.

**Email.** Queued in the business transaction → `accepted` only when the provider
accepts → `delivered` only from the provider's webhook. With no provider configured the
message stays queued and nothing ever reports success.

### Verified

200 tests, up from 175.

### Three bugs the tests found

1. **The customer site could not resolve its tenant.** Hostname resolution joined
   `tenant_domains` to `tenants` in one query; `tenants` is scoped to the caller's own
   row and no context exists yet, so RLS returned nothing — silently. Every other path
   resolves inside a context, so nothing caught it until the site actually ran.
   Resolution is now two steps: the domain gives an id, the id gives a context. Regression
   suite in `tests/integration/tenant-resolution.test.ts`.

2. **The background worker claimed nothing, and reported success.** It queried the job
   queue across all tenants as the application role; RLS refused, the batch came back
   empty, and `runWorker` cheerfully returned `{claimed: 0}`. The worker now enumerates
   tenants through the control plane and does every piece of work inside a tenant
   context. The same bug was latent in the outbox drain. `tests/integration/worker.test.ts`
   exists because nothing watches a worker fail.

3. **Availability is per model, and a test proved it.** Slots free for *some*
   demonstrator are not free for *the S5's* demonstrator. The tool description now says
   so explicitly, and the demonstration passes the model to both the slot query and the
   booking — which is what the assistant does.

Plus a fixture bug worth noting: the fake email provider returned one id for every
message, which made delivery lookups ambiguous the moment a drain swept more than one.
Real providers never do that.

### What is still NOT verified

**No live model call has been made.** Still no `ANTHROPIC_API_KEY`. The client is written
against the current API and the whole spine around it is exercised with a scripted model,
but the assistant has never spoken to Claude. This is now the single largest gap: the
product is the chatbot, and the chatbot's own behaviour — tool selection, phrasing,
when it decides to hand off — is the one part that cannot be asserted without a key.

**Responses are not streamed.** The tool loop needs complete messages, so the endpoint
returns the reply in one piece and the interface shows a pending state. For a
conversational product this is a real UX gap, not a cosmetic one. Streaming the final
turn (after the tool loop settles) is the fix and is the first thing I would do in M5.

### Deliberately not built

- **A visual configurator.** The pricing engine and the tools behind one are complete and
  tested; the interactive page is a website feature, and the website is not the product.
- **Comparison and finance pages.** Both capabilities exist as tools, which is where they
  matter. The assistant can compare two cars and estimate a payment today.
- **Portal depth** — assignment, status transitions, notes, tickets, analytics. M5.

---

## M5 — Streaming, evaluation and operations ✅

### Built

| Area | Where |
|---|---|
| Streaming replies (SSE) | `src/server/ai/client.ts`, `conversation.ts`, `api/chat/route.ts` |
| Customer-safe progress while tools run | `TOOL_STATUS` in `conversation.ts` |
| Evaluation corpus and runner | `src/server/ai/evals/` |
| `npm run eval` / `npm run eval:live` | `scripts/eval.ts` |
| Follow-up rules and evaluation | `src/server/services/follow-ups/` |
| Staff actions: status, assignment, notes | `src/server/services/leads/actions.ts` |
| Portal forms and follow-up queue | `src/app/(portal)/portal/(dashboard)/` |
| Recurring work on a schedule | `api/cron/worker/route.ts`, `vercel.json` |

**Streaming.** `stream.on('text')` feeds deltas out while `finalMessage()` still gives
the loop the complete message it needs to dispatch tools — so streaming is an addition
to the loop, not a different shape of it. The preamble before a tool call streams too,
because that is the part that makes waiting feel like conversation. While a tool runs
the customer sees *"Checking what we have in stock"*, never a tool name; a test asserts
every one of the 22 tools has a phrase.

**Evaluation.** Two modes, and the distinction is the point. **Scripted** supplies the
tool calls and measures the *system* — grounding, refusals, leakage, scoring — and runs
in CI with no key. **Live** lets the model choose and measures the *model* — whether it
reaches for the right tool, declines to invent, hands off instead of negotiating. A case
declares which mode it belongs to, because a live case scripted into passing is worse
than no case at all. Nine scripted cases pass today; three live cases are waiting for a
key.

**Follow-ups create tasks for people, never messages to customers.** Spec §14 is explicit
about not chasing customers, and automated outbound on a dealership's behalf is a
liability that belongs to a human. Evaluation is idempotent on
`(tenant, lead, rule, due_at)`, and a batch produces one staff notification rather than
one per task.

**Priority is computed; status is owned by a person.** Staff move a lead through a
declared pipeline — `won` is terminal, `new → won` is refused with the allowed
transitions attached so the UI can offer them — and every move records who made it.

### One real bug, found by running the suite twice

**Concurrent bookings could deadlock, and the customer saw a database error.**

A test drive holds two resources: a salesperson and a car. They were inserted in
whatever order they were found, so one booking could hold the salesperson while another
held the car, each waiting for the other. Postgres resolves that by killing a
transaction with `40P01` — which is not the exclusion violation the code was catching,
so it escaped untyped and reached the customer as `DrizzleQueryError: insert into
"appointment_resources"…`.

Two fixes, both kept: holds are now acquired in a deterministic order, so the deadlock
cannot form; and `40P01` and `40001` are treated as what they mean to a customer —
someone else got there first. `tests/integration/booking.test.ts` reproduces the original
contention pattern.

It took running the suite twice without resetting the database to surface it, which is
worth remembering: a test suite that is only ever run against a clean database will not
find the bugs that only appear under load.

Three test-isolation faults were fixed alongside it — a worker test whose fixed marker
accumulated rows across runs, and two assertions that read "the first matching row" from
a shared table. All three made diagnosis harder than the bug itself.

### What is still NOT verified

**No live model call has been made.** Still no `ANTHROPIC_API_KEY`. `npm run eval:live`
exists and is ready; the three live cases are written. This remains the single largest
gap, and it is now the *only* structural one.

### Deliberately not built

- **Analytics.** Spec §42 is explicit that analytics come after operations work, and
  they now do — but pipeline charts are worth less than the follow-up queue, which
  shipped instead.
- **Ticket and appointment queues in the portal.** Both entities are complete and
  tested; the staff-facing lists are presentation and can follow.
- **Tenant settings UI.** Scoring weights and follow-up rules are seeded as rows and
  read from the database, so they are tunable today — through SQL rather than a form.

---

## Gap closure — the answer to "what's missing?" ✅

An audit against the specification and the running code, then the fixes that did not
need anything from outside this environment.

### Fixed

| Gap | What it was | What it is now |
|---|---|---|
| Rate limiting | An in-process `Map`. Every serverless instance had its own, so a public endpoint calling a paid model was effectively unlimited | A Postgres counter, incremented in one statement so two concurrent requests cannot both read zero. Returns `Retry-After` |
| Conversation memory | `rolling_summary` existed and nothing wrote it; past ~12 turns a conversation silently forgot | Written by the extraction pass from the structured signals — so it cannot invent a detail — and read back into the prompt |
| Retention | Nothing. Conversations kept names, phones, budgets and trade-in details forever | A retention job redacts message bodies past the tenant's window, keeps the lead, appointment, ticket and audit trail, and audits the redaction itself. Plus an erasure path for a customer request |
| AI budget | `monthlyTokenBudget` was seeded and never read | Spend is recorded per tenant per month; over budget degrades the assistant to the contact form, so a customer sees a service problem and never a billing one |
| Cancelling a test drive | Documented as a tool, never built. A customer who could not make it had to telephone, and the car stayed blocked | `cancelTestDrive`, which **releases the holds** so the slot returns to the market. Two factors: the confirmation code AND the email — a six-character code alone would let anyone cancel a stranger's booking |
| Customer ticket lookup | A reference number with no way to look it up | A single-use, expiring, ticket-scoped link in the confirmation email. Still no lookup by email — that would be an enumeration endpoint. Only the token's SHA-256 is stored |
| Service tickets | The assistant could file one and nobody could open it | A ticket queue, filtered by whether the viewer holds the sales or service permission |
| Appointments | No diary | An upcoming-appointments view grouped by day in the dealership's own timezone |

### Two things the tests caught during the work

1. **`rate_limit_counters` carried a `tenant_id` with no policy behind it.** The isolation
   suite requires every table with that column to have one, and correctly refused. The
   column was never written — the tenant is part of the opaque subject key, because the
   chat endpoint has to refuse a request *before* a tenant context exists. Migration 0005
   drops it rather than adding a policy that would imply a scoping that does not exist.

2. **The suite was only repeatable once.** Running it a second and third time surfaced
   three separate faults: an email backlog starving new messages out of the drain batch
   (correct oldest-first behaviour, wrong test), and booking tests that accumulated
   appointments until the finite demonstrator fleet saturated. The harness now starts
   each run from a known booking state, and the suite is stable across four consecutive
   runs without a reset.

### Live evaluation — attempted, cannot run here

Asked to connect the API and run the live corpus, I checked properly rather than
assuming: no `ANTHROPIC_API_KEY`, no `ANTHROPIC_AUTH_TOKEN`, no `ant` CLI, no credential
profile on disk. `ANTHROPIC_BASE_URL` is set but is simply `https://api.anthropic.com`,
which returns `401 — x-api-key header is required`.

So the live corpus has not run, and no live result is reported. What was built instead,
so that it is one command when a key exists:

- The client now uses the SDK's own credential resolution, so a key, a token or an
  `ant auth login` profile all work.
- The runner meters every request and **stops itself** at 60 requests, 400k tokens or
  **$2.00**, whichever comes first — a live run spends real money on someone else's
  account and should not depend on the corpus staying small.
- It reports tokens and estimated cost per case and in total.
- `scripts/measure-prompt.ts` measures the real payload: **911-token system prompt,
  3,655-token tool definitions, ~4,566 tokens of fixed prefix per request.** A full live
  corpus run is roughly **$0.34 with prompt caching, $0.97 without** — the prefix is
  marked cacheable, which is most of the difference.

---

## M6 — next

Production readiness: accessibility, error and empty states, deployment, and onboarding a
second dealership by configuration alone — the real test of the multi-tenant claim.
