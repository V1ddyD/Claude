# Sinclair — AI Dealership Automation Platform

A multi-tenant dealership operating system. Customer conversations become structured
dealership operations: leads, appointments, tickets, follow-ups and notifications.

**Sinclair** is a fictional premium automotive brand, used as tenant #1 and as the
demonstration environment. It is not hardcoded — it is seed data.

## The product in one sentence

Not "we built a chatbot". The product is: *a customer talks to Sinclair in natural
language, and the dealership's operational systems fill themselves in correctly.*

## Three surfaces, one backend

| Surface | Audience | Path |
|---|---|---|
| Customer website + AI assistant | Public | `/` |
| Dealer Portal | Authenticated staff | `/portal` |
| Backend / AI tool layer | Neither — internal | `src/server/**` |

Business logic lives **only** in the backend. The two front-ends are views over it.

## Status

**M5 — Streaming, evaluation and operations, complete.** Built and verified so far:

- Schema applied and migrated (47 tables, 44 tenant-scoped)
- Tenant isolation enforced by Postgres RLS, proven by a non-skippable suite
- Permission-based authorization, with the matrix asserted against the database
- Audit logging that commits with the change it describes, append-only at the grant level
- Dealer Portal signs in and renders per-role navigation for two separate tenants
- A real catalogue — 10 models, 36 configurations, 51 options, 86 inventory units —
  with a buildable matrix rather than a cartesian product
- A pricing engine where every price is computed and invalid builds are refused with
  the valid alternatives attached
- An inventory state machine driven by a transition table, with optimistic concurrency
- An AI tool layer where the model cannot name a tenant, a customer or a query — and
  where every result passes through a hand-written projection before it sees it
- Test drive booking in one transaction, with double booking prevented by Postgres
- Lead extraction with per-field confidence, scored by configurable rules rather than
  by the model
- A Dealer Portal showing the lead, its evidence, the appointment, the ticket and the
  whole conversation

- **22 assistant tools** — browse, compare, price, check stock, estimate finance, book a
  test drive, request a callback, a trade-in appraisal or financing, or hand over to a
  person. Every write requires explicit contact consent; none promises an outcome
- Conversation memory, so the customer is never asked the same thing twice
- A transactional email outbox that reports `delivered` only when the provider says so

- **Streamed replies**, with a plain-language note while a tool runs
- An **evaluation corpus** — `npm run eval` measures the system, `npm run eval:live`
  measures the model
- Follow-up rules that create tasks for staff, never messages to customers
- Lead assignment, a declared status pipeline, and internal staff notes

- Durable rate limiting, per-tenant AI budget, conversation memory across long chats,
  data retention and erasure
- Test drive cancellation that releases the car, and a single-use link so a customer can
  look up their own request

236 tests pass against a real PostgreSQL 16, stable across repeated runs, including
**the spec §44 demonstration scenario end to end**. Next: **M6 — production readiness.**

> **One known gap.** No `ANTHROPIC_API_KEY` has been configured, so the model client is
> written but has never run — everything around it is tested with a scripted model, and
> `npm run eval:live` is ready for the day a key exists.
> See `docs/06-implementation-log.md` -> M5.

## Quick start

```bash
npm install
cp .env.example .env.local        # set ANTHROPIC_API_KEY here, once
./scripts/test-db.sh start        # throwaway Postgres; writes .env.test.local
npm run db:migrate
npm run db:seed                   # 10 models, 36 configurations, 86 units
npm test
npm run dev                       # site at /, portal at /portal
```

### The assistant's API key

The key is **the operator's, set once, server-side**. Customers never supply, see, or
are asked for one — a visitor opens the chat and types.

It is read by exactly one module (`src/server/ai/client.ts`), has no `NEXT_PUBLIC_`
alias, and never reaches the browser. Three independent things enforce that: an ESLint
restricted-import rule, `tests/unit/key-never-reaches-customer.test.ts`, and a CI grep
of the built client bundle.

Without a key the assistant degrades to a contact form and says so in plain language.
It never shows a customer anything about configuration.

Without Supabase configured, the portal signs in against seeded staff accounts.
That adapter replaces the identity provider only — roles, permissions and tenant
isolation are unchanged — and it refuses to load in production.

## Documents

Read in order:

0. [`docs/06-implementation-log.md`](docs/06-implementation-log.md) — what is built,
   what is verified, and what each milestone changed about the plan.
1. [`docs/00-architecture.md`](docs/00-architecture.md) — system architecture, tenancy,
   auth, AI tool layer, lead scoring, booking concurrency, email/tickets, security model.
2. [`docs/01-data-model.md`](docs/01-data-model.md) — entity model and the reasoning
   behind the non-obvious tables.
3. [`db/migrations/0001_initial_schema.sql`](db/migrations/0001_initial_schema.sql) — the proposed DDL, concrete and reviewable.
4. [`docs/02-project-structure.md`](docs/02-project-structure.md) — file layout and
   the layering rules that keep logic out of the UI.
5. [`docs/03-ai-tools.md`](docs/03-ai-tools.md) — the tool contracts Claude is allowed
   to call, and the rules that bound them.
6. [`docs/04-spec-review.md`](docs/04-spec-review.md) — contradictions, gaps and the
   changes recommended **before** implementation starts.
7. [`docs/05-roadmap.md`](docs/05-roadmap.md) — implementation phases and exit criteria.

## Decisions at a glance

| Area | Decision |
|---|---|
| Framework | Next.js (App Router) + TypeScript, one deployment, two route groups |
| Database | PostgreSQL (Supabase), Drizzle ORM, SQL migrations in-repo |
| Tenancy | `tenant_id` on every row + per-request Postgres GUC + RLS as backstop |
| Staff auth | Supabase Auth + `staff_users` row required for any portal access |
| Customer auth | Anonymous visitor session by default; magic link for profile access |
| AI | Claude, server-side only, restricted tool registry, no SQL access |
| Lead priority | Deterministic configurable rule engine over AI-extracted signals |
| Double booking | Postgres `EXCLUDE` constraint on resource time ranges |
| Email | Transactional outbox + provider webhooks, never "sent" until accepted |
| Background work | Postgres job queue drained by a cron-invoked worker route |
