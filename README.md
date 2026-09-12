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

**M8 — The scripted AI layer, complete.** Built and verified so far:

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

- **A dealership is configuration, not a release** — `npm run onboard` brings one up on
  its own hostname, timezone, currency and ticket series, proven by a test that stands up
  a third dealership from a config object alone

- **A scripted AI implementation** selected by `AI_PROVIDER`, so the product runs with no
  credential at all. It holds no dealership's catalogue: models come from the tenant's own
  range and trims, colours and engines are resolved against what the tools return. It
  extracts lead evidence deterministically into the same rule engine
- Proven across **every model in the catalogue** and against a second dealership with an
  entirely different range, whose assistant does not recognise the first one's model names

348 tests pass against a real PostgreSQL 16, stable across repeated runs, including
**the spec §44 demonstration scenario end to end**.

Operations: [`docs/07-operations.md`](docs/07-operations.md).
Security: [`docs/08-security-review.md`](docs/08-security-review.md).

> **One known gap.** No `ANTHROPIC_API_KEY` has been configured, so the Claude client is
> written but has never run. The product does not wait on it: `AI_PROVIDER` defaults to
> the scripted assistant, which drives the same 22 tools against the same data. What
> remains unmeasured is the model's own judgement — `npm run eval:live` is built, metered
> and capped at $2.00 for the day a key exists.
> See `docs/06-implementation-log.md` -> M8.

## Run it on your machine

You need **Node 20.11+** and **PostgreSQL 16**. No API key: without one the assistant
runs its scripted implementation, on the same tools and the same data.

```bash
git clone https://github.com/V1ddyD/Claude.git sinclair && cd sinclair
npm install

docker compose up -d              # PostgreSQL on 127.0.0.1:5432
cp .env.example .env.local        # the defaults match docker compose

npm run db:migrate                # 47 tables, RLS, roles
npm run db:seed                   # 10 models, 36 configurations, 86 units
npm run dev
```

Then open:

| | |
|---|---|
| **http://localhost:3000** | the customer site. The assistant is the button at the bottom right |
| **http://localhost:3000/models** | the range, priced from the catalogue |
| **http://localhost:3000/portal** | the Dealer Portal — click a seeded name to sign in |

Sign in as **Marcus Hale** (sales) or **Priya Raman** (manager) and you will see the
lead your own conversation just created, with the evidence behind its priority, the
appointment, the ticket and the full transcript.

Something worth trying: book a test drive in the chat, then open the portal. The
conversation is what filled it in.

### Without Docker

Any PostgreSQL 16 works. Create a database, then point `.env.local` at it:

```
DATABASE_URL=postgres://app_user@localhost:5432/sinclair
DATABASE_ADMIN_URL=postgres://postgres@localhost:5432/sinclair
```

`DATABASE_ADMIN_URL` is the owner and runs migrations; `DATABASE_URL` is the
unprivileged role the application uses, created by migration `0002`. They are
deliberately different — tenant isolation depends on the second one not being the owner.
If your server requires passwords, give the role one after migrating
(`ALTER ROLE app_user PASSWORD '…'`) and put it in the URL.

On Linux, `./scripts/test-db.sh start` stands up a throwaway cluster instead and writes
the URLs to `.env.test.local`. That is what CI and `npm test` use.

```bash
npm test                          # 348 tests against a real PostgreSQL
npm run eval                      # measures the system
npm run eval:rules                # measures the assistant that ships today
```

### The assistant's API key

The key is **the operator's, set once, server-side**. Customers never supply, see, or
are asked for one — a visitor opens the chat and types.

It is read by exactly one module (`src/server/ai/client.ts`), has no `NEXT_PUBLIC_`
alias, and never reaches the browser. Three independent things enforce that: an ESLint
restricted-import rule, `tests/unit/key-never-reaches-customer.test.ts`, and a CI grep
of the built client bundle.

Without a key the scripted assistant answers instead — the same tools, the same live
data, a fixed set of instructions rather than a model. Set `AI_PROVIDER=anthropic` and a
key to switch; nothing else about the site, the backend or the portal changes. A customer
is never shown anything about configuration either way.

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
