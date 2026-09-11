# Project Structure

```
sinclair/
├── db/
│   ├── schema.sql                  # the proposed schema (this phase)
│   ├── migrations/                 # forward-only, versioned, applied in CI
│   ├── seeds/                      # sinclair.ts — tenant #1 and the demo data
│   └── validate/                   # Phase-0 constraint + RLS proofs
│
├── src/
│   ├── app/
│   │   ├── (site)/                 # CUSTOMER — no session required
│   │   │   ├── page.tsx                      /
│   │   │   ├── models/[slug]/page.tsx        /models/s5
│   │   │   ├── configurator/[slug]/page.tsx
│   │   │   ├── compare/ inventory/ finance/
│   │   │   ├── trade-in/ test-drive/ contact/ about/
│   │   │   └── confirmation/[ticket]/page.tsx
│   │   │
│   │   ├── (portal)/portal/        # STAFF — session + permission required
│   │   │   ├── page.tsx                      dashboard
│   │   │   ├── leads/[id]/page.tsx
│   │   │   ├── appointments/ tickets/ inventory/
│   │   │   ├── customers/[id]/ analytics/
│   │   │   └── settings/           # admin only
│   │   │
│   │   └── api/
│   │       ├── chat/route.ts               # streaming, Node runtime
│   │       ├── webhooks/email/route.ts     # signature-verified
│   │       └── cron/worker/route.ts        # authenticated queue drain
│   │
│   ├── server/                     # ◀── ALL BUSINESS LOGIC LIVES HERE
│   │   ├── context/                # tenant resolution, visitor + staff sessions
│   │   ├── db/
│   │   │   ├── client.ts           # the only place a connection is created
│   │   │   ├── tenant-db.ts        # withTenant(): opens tx, SET LOCAL app.tenant_id
│   │   │   ├── schema.ts           # Drizzle definitions
│   │   │   └── repositories/       # accept TenantDb, never a raw client
│   │   ├── services/
│   │   │   ├── catalogue/  pricing/  inventory/
│   │   │   ├── leads/      scoring/   ← the rule engine
│   │   │   ├── booking/    availability/
│   │   │   ├── tickets/    numbering/
│   │   │   ├── finance/    trade-in/
│   │   │   ├── email/      outbox + templates
│   │   │   ├── notifications/  follow-ups/
│   │   │   └── audit/
│   │   ├── ai/
│   │   │   ├── client.ts           # ANTHROPIC_API_KEY read ONLY here
│   │   │   ├── conversation.ts     # Pass A — the customer loop
│   │   │   ├── extraction.ts       # Pass B — signals + scoring input
│   │   │   ├── prompts/
│   │   │   ├── tools/
│   │   │   │   ├── registry.ts     # enforces the four invariants
│   │   │   │   ├── define.ts
│   │   │   │   ├── read/  write/
│   │   │   │   └── projections/    # the leak boundary — small and tested
│   │   │   └── evals/
│   │   ├── auth/                   # requireStaff, permissions, visitor sessions
│   │   ├── jobs/                   # queue + handlers
│   │   └── errors.ts               # typed domain errors → safe messages
│   │
│   ├── components/
│   │   ├── ui/                     # shared primitives
│   │   ├── site/                   # customer-only
│   │   └── portal/                 # staff-only
│   │
│   ├── lib/                        # isomorphic, dependency-free helpers
│   └── middleware.ts               # redirect only; NOT the authz boundary
│
├── tests/
│   ├── unit/  integration/  e2e/
│   └── isolation/                  # non-skippable tenant isolation suite
└── docs/
```

---

## Layering rules

```
app/ ──▶ server/services ──▶ server/db/repositories ──▶ Postgres
             ▲
server/ai/tools ─────────────┘        (tools call services, never repositories)
```

Enforced, not merely recommended:

| Rule | How it's enforced |
|---|---|
| `components/` never imports from `server/` | ESLint boundary rule |
| `app/` never imports a repository directly | ESLint boundary rule |
| Only `server/db/client.ts` creates a connection | ESLint restricted import |
| Only `server/ai/client.ts` reads `ANTHROPIC_API_KEY` | ESLint restricted import + CI grep of the built client bundle |
| Portal pages call `requireStaff()` | integration test enumerating every portal route |
| Repositories take `TenantDb`, never a raw client | types make the alternative unconstructable |

The single most important rule: **AI tools call services, not repositories.** A tool that
reaches the database directly would skip the validation the portal enforces, which is
exactly the divergence this architecture exists to prevent.

## File size

No file over ~300 lines. Services split by use case (`booking/create-test-drive.ts`,
`booking/cancel.ts`), not by entity. Spec §58's "avoid giant files" is a real constraint,
and the natural failure here is one 2,000-line `leads.ts`.

## Naming

Database: `snake_case`, plural tables. TypeScript: `camelCase`, `PascalCase` types.
Routes: `kebab-case`. Permissions: `entity.action.scope` (`lead.read.assigned`).
Money: always a `Cents` suffix on integers (`priceCents`) so a bare `price` is a
review flag.

## Environment

```
DATABASE_URL              # app_user — not the owner, not BYPASSRLS
DATABASE_ADMIN_URL        # migrations only, never in the request path
SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY         # server-only, one importer
RESEND_API_KEY / RESEND_WEBHOOK_SECRET
CRON_SECRET
SESSION_SECRET            # visitor cookie signing
DEFAULT_TENANT_SLUG       # local dev only
```

Only `NEXT_PUBLIC_*` reaches the browser, and no key is ever given that prefix. The
request path uses `app_user`; the service-role key is confined to tenant provisioning.
