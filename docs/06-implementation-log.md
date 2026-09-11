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

## M2 — Catalogue and pricing — next

Catalogue repositories and services, the pricing engine with buildability validation,
the full Sinclair seed, and the inventory state machine. Exit: every price is computed,
invalid combinations are rejected, and no magic numbers remain.
