# Schema validation harness

These scripts prove the schema's safety claims against a real Postgres 16 instance.
They are a Phase-0 stand-in for the integration suite described in
`docs/00-architecture.md` §14, and should be ported into that suite in Phase 2 rather
than kept as loose SQL.

```bash
export PATH=/usr/lib/postgresql/16/bin:$PATH
D=/tmp/pgval; rm -rf $D; mkdir -p $D; chown postgres:postgres $D
su postgres -c "initdb -D $D/data -U postgres --auth=trust"
su postgres -c "pg_ctl -D $D/data -o \"-k $D -c listen_addresses=''\" -l $D/log start"
su postgres -c "psql -h $D -U postgres -c 'CREATE DATABASE sinclair'"
su postgres -c "psql -h $D -U postgres -d sinclair -v ON_ERROR_STOP=1 -f db/migrations/0001_initial_schema.sql"
su postgres -c "psql -h $D -U postgres -d sinclair -f db/validate/constraints.sql"
su postgres -c "psql -h $D -U postgres -d sinclair -f db/validate/rls-setup.sql"
su postgres -c "psql -h $D -U app_user  -d sinclair -f db/validate/rls-isolation.sql"
```

## What is asserted

`constraints.sql` — nine cases. Those marked MUST FAIL are expected to raise:

| # | Assertion | Result |
|---|---|---|
| T1 | A test drive books the 11:30 slot | inserted |
| T2 | A second customer overlapping the same resource | rejected — `23P01` exclusion violation |
| T3 | Back-to-back booking starting exactly at the previous end | inserted (half-open `[)` range) |
| T4 | Appointment in tenant B referencing tenant A's customer | rejected — composite FK |
| T5 | `ends_at` before `starts_at` | rejected — CHECK |
| T6 | Unit marked `reserved` with no `reserved_until` | rejected — CHECK |
| T7 | BEV powertrain with no `battery_kwh` | rejected — CHECK |
| T8 | `v_public_inventory` with available + reserved + sold units | only the available unit is visible |
| T9 | Bookings on the shared resource | exactly two, non-overlapping |

T2 is the important one: **double booking is rejected by Postgres, not by application
logic**, so it holds under concurrency with no application-level locking.

`rls-isolation.sql` — run as `app_user`, a role that is neither table owner nor
`BYPASSRLS`:

| Assertion | Result |
|---|---|
| Sinclair context reads Sinclair customers | 2 rows |
| Tenant B context reads Sinclair customers | 0 rows |
| **No tenant context set at all** | 0 rows — fails closed, does not leak everything |
| Insert a row carrying another tenant's id | rejected — `WITH CHECK` |
| `DELETE`/`UPDATE` on `audit_logs` | rejected — append-only grant |

RLS was applied to all 44 tenant-scoped tables by generated DDL, so a new table cannot
be added without a policy by omission.

## Defect this harness already caught

`audit_logs` originally used `bigserial`, which requires a separate `USAGE` grant on the
underlying sequence — the application role could not insert an audit row at all, which
would have failed silently at the worst possible moment. Changed to
`GENERATED ALWAYS AS IDENTITY`, where table-level `INSERT` is sufficient. Re-verified.
