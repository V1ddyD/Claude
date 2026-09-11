# Security Review

Run against the model in `docs/00-architecture.md` §13. Every line below was checked
against the running code, not asserted from the design.

Date: the M6 milestone. Re-run before each deploy.

---

## Verified

| Control | Evidence |
|---|---|
| No secret reaches the browser | The built client bundle contains no reference to any key — checked by grep, by `tests/unit/key-never-reaches-customer.test.ts`, and by CI |
| Tenant isolation | RLS on all 47 tenant tables, forced; `app_user` is not owner, not superuser, not `BYPASSRLS`; 15 assertions in `tests/isolation/` run as that role |
| Fails closed | No tenant context returns **zero rows**, not everything. Asserted per table |
| Cross-tenant references impossible | Composite foreign keys carry `tenant_id`, so a child cannot point at another tenant's parent even from `psql` |
| Every portal route authorizes itself | 7 route files checked; only `sign-in` is unguarded, which is necessary and asserted |
| Server actions re-authorize | All 4 call `withStaff` independently — the button being hidden proves nothing about who can POST |
| No SQL built from user input | No `unsafe(` outside the migration runner |
| The model has no query surface | Registry rejects any tool declaring `sql`, `query`, `where`, `filter`, `orderBy`, `table`, `columns` — case-insensitively |
| The model cannot name a tenant or customer | Registry rejects any tool declaring an identity field; both come from the server-side session |
| Write endpoints authenticated | Cron by shared secret in constant time; webhook by signature **verified before the body is parsed**; chat by rate limit |
| Audit log append-only | `app_user` holds `INSERT, SELECT` on `audit_logs` and nothing else |
| Cookies | `HttpOnly`, `SameSite=Lax`, `Secure` in production |
| Rate limiting survives restarts | A Postgres counter, not an in-process map |
| Errors reveal nothing | Typed domain errors; `forbidden` and `not found` are worded identically so neither confirms a record exists |

## Deliberate exceptions, each named

Four modules open their own connection or read outside a tenant context. Each is a
single file with a comment explaining why, and the lint rule that would otherwise ban it
names them explicitly — so a fifth cannot appear unnoticed:

| Module | Why |
|---|---|
| `db/client.ts` | The one place a pool is created |
| `db/migrate.ts` | Runs before the application boots |
| `db/control-plane.ts` | The worker must enumerate tenants; returns **ids only** |
| `services/onboarding/` | Creating a tenant necessarily precedes a tenant context |
| `auth/dev-directory.ts` | Development identity provider; refuses in production |

`tenant_domains` is readable without a context — deliberately, because hostname
resolution happens before a tenant is known. It holds a hostname and an id, nothing else.

## Open items

| Item | Assessment |
|---|---|
| **No MFA** | Recommended for MANAGER and ADMIN before a second dealership is live. Supabase supports it; it is a configuration and a guard, not a rearchitecture |
| **Fixed-window rate limiting** | A caller can send two bursts across a window boundary. Adequate against abuse, imprecise as a quota. A sliding window is the fix if it matters |
| **Prompt injection** | Mitigated structurally rather than by detection: customer text never enters the system prompt; tool inputs are schema-validated so injected text cannot become a parameter; there are no destructive tools. Worst case from a successful injection is a spurious lead in the attacker's own conversation |
| **No secret rotation procedure** | Keys are read from the environment, so rotation is a redeploy. Worth writing down before there is more than one operator |
| **Dev auth adapter** | Refuses to load in production and is disabled the moment a real provider is configured. Still worth removing entirely once Supabase is provisioned |

## Not applicable

No payment card data is stored anywhere, by design (spec §31). No passwords are stored —
authentication belongs to the identity provider.
