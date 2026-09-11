# Implementation Roadmap

Spec §59's fifteen phases, regrouped into six milestones with explicit exit criteria.
The one substantive change: a **walking skeleton** before the polished surfaces, so the
riskiest integration is proven first rather than last. See `docs/04-spec-review.md` §17.

---

## M0 — Architecture ✅

Design, schema, tool contracts, spec review. No application code, per §60.

**Exit:** architecture reviewed and agreed. Open questions in §63 below answered.

---

## M1 — Foundation ✅ *(spec phases 2–4)*

Next.js + TypeScript + Tailwind skeleton. Drizzle schema from `db/migrations/0001_initial_schema.sql` as
migration 0001, RLS generated for every tenant table. `withTenant()` and the repository
layer. Supabase Auth, `staff_users`, the permission matrix, `requireStaff()`. Tenant
resolution by hostname. Audit logging. Typed errors. CI: lint, typecheck, test, migrate.

**Exit:** the tenant isolation suite passes against real Postgres, including the
assertion that a missing tenant context returns zero rows. A staff user can sign in and
see an empty portal. *(The Phase-0 harness in `db/validate/` becomes part of this suite.)*

---

## M2 — Catalogue and pricing ✅ *(spec phase 5)*

Catalogue repositories and services. The pricing engine: base + powertrain + trim +
options + colour, with buildability validation against `model_configurations` and option
requires/excludes rules. Full Sinclair seed — ten models, multiple powertrains and
model-appropriate trims each, options with package rules, ~40 inventory units across
states. Inventory state machine with optimistic concurrency.

**Exit:** every price in the catalogue is computed, never stored as a magic number.
Invalid combinations are rejected with a typed error. Property tests: no option is
double-charged when standard on its trim; no build prices below its configuration base.

---

## M3 — The walking skeleton ✅ *(the change to §59)* — next

Deliberately unpolished, deliberately end to end:

one plain chat page → `/api/chat` streaming → three read tools → one write tool
(`createTestDrive`) → lead created → Pass B extraction → priority scored → appointment
booked → ticket numbered → email queued → one plain portal row showing all of it.

**Exit:** the §44 demonstration scenario runs start to finish, ugly but real. Every later
milestone then fills in a slice whose shape is already proven.

This milestone exists because the AI → lead → portal spine is where the product succeeds
or fails, and §59's ordering would have validated it in phase 8 of 15 — after the entire
website was built on assumptions about it.

---

## M4 — The assistant ✅ *(rescoped: the chatbot is the product)*

Now the surfaces, each against a working spine.

- **Website** — home, catalogue, detail pages, comparison, inventory, finance, trade-in,
  contact, about. Premium editorial design: restrained palette, strong typography,
  subtle motion, real specification tables. Mobile first, accessible, fast.
- **Configurator** — powertrain → trim → options → colour → live price, saveable and
  shareable, availability-aware.
- **Assistant** — the full tool set, context management, pinned facts, handoff,
  the evaluation corpus, degraded mode.
- **Booking** — computed availability, the exclusion constraint under concurrency,
  graceful conflict re-offer, cancellation.
- **Tickets and email** — numbering, outbox, provider webhooks, templates, confirmation
  slips with absolute local dates.
- **Dealer Portal** — dashboard, lead list and detail with the full conversation and AI
  summary, appointments, tickets, inventory, customers, staff notes, activity timeline,
  assignment, status transitions.

**Exit:** every §57 scenario passes, including two customers racing one slot, a vehicle
selling mid-conversation, an email provider failure, and a retry that must not duplicate.

---

## M5 — Streaming, evaluation and operations ✅

Follow-up rules and staff tasks. Staff notifications, deduplicated. Hold expiry.
Operational analytics: leads over time, priority mix, conversion, response time, popular
models and configurations, open tickets, pipeline.

**Exit:** a high-priority lead left untouched produces a staff task with a reason and a
recommended action — and no automated message to the customer.

---

## M6 — Production readiness *(spec phases 14–15)* — next

Security review against the §13 model. Rate limits and token budgets. Load and
concurrency testing on booking. Accessibility audit. Error, loading and empty states
everywhere. Performance budget. Retention and erasure jobs. Runbook and deploy.

**Exit:** a second tenant can be onboarded by configuration and seed data alone, with no
code change. That is the real test of whether the multi-tenant claim is true.

---

## Sequencing principles

1. **Nothing fake.** If a surface isn't wired to the backend, it doesn't ship — §60.
2. **Riskiest first.** The AI spine before the pretty pages.
3. **Constraints before features.** The exclusion constraint before the booking UI; RLS
   before the first customer row.
4. **Every milestone demoable.** M3 onward, the §44 scenario runs at every stage.

---

## Decisions (answered 2026-09-11)

| # | Question | Decision |
|---|---|---|
| 1 | Vehicle imagery | **Generated renders**, with the editorial treatment as the development fallback. Every image goes through one `<VehicleImage>` component with an editorial placeholder, so renders drop in per model as they land without touching page code. |
| 2 | Market | **CAD, `America/Toronto`, `en-CA`.** Seeded as tenant defaults, not constants. |
| 3 | Customer accounts | **Anonymous visitor + scoped magic link.** Accounts deferred to M5; `customers.auth_user_id` is already present so adding them is not a migration. |
| 4 | Email provider | **Resend.** Behind an `EmailProvider` interface so the outbox does not depend on it. |
| 5 | Lead priority | **Rules decide; the AI extracts evidence.** As described in `04-spec-review.md` §1. |
| 6 | Conversation retention | **24 months, then redaction.** Tenant-configurable; a scheduled job redacts message bodies and PII while keeping transactional records. |
| 7 | MFA | **Not in v1. Required for MANAGER and ADMIN before tenant #2 exists.** Tracked as an M6 exit item. |

Decision 1 has a build consequence worth stating: because renders arrive incrementally,
no page may assume an image exists. The placeholder is the default state, not an error
state.

Decision 3 has a security consequence: there is no customer login in v1, so every
customer-facing data read is either public catalogue data or reached through a
single-use scoped token. No session can be escalated into profile access, because there
is no customer session to escalate.
