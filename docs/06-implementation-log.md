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

## M4 — Depth — next

The customer website, the configurator, the chat interface, the full tool set, email
delivery, and the rest of the Dealer Portal — each against a spine that already works.
