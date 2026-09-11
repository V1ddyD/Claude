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

**Phase 0 — architecture.** No application code yet, by design (spec §60, §63).
What exists is the design that the implementation will follow.

## Documents

Read in order:

1. [`docs/00-architecture.md`](docs/00-architecture.md) — system architecture, tenancy,
   auth, AI tool layer, lead scoring, booking concurrency, email/tickets, security model.
2. [`docs/01-data-model.md`](docs/01-data-model.md) — entity model and the reasoning
   behind the non-obvious tables.
3. [`db/schema.sql`](db/schema.sql) — the proposed DDL, concrete and reviewable.
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
