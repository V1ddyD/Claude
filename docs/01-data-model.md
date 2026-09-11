# Data Model

The DDL is [`db/schema.sql`](../db/schema.sql), commented inline. This document covers
only the decisions that are not obvious from reading it.

**Verification status:** the schema applies cleanly to PostgreSQL 16, and its safety
properties are asserted by [`db/validate/`](../db/validate/README.md) — including that
double booking is rejected by the database and that a missing tenant context returns
zero rows rather than everything.

---

## Ten decisions worth defending

### 1. Composite foreign keys carry `tenant_id`

```sql
FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
```

rather than the simpler `REFERENCES customers(id)`. Every tenant-scoped parent therefore
carries a redundant-looking `UNIQUE (tenant_id, id)`.

This makes a cross-tenant reference **structurally impossible**: an appointment in
tenant B cannot point at a customer in tenant A even if application code is wrong, even
if RLS is misconfigured, even via a direct `psql` session. Verified as case T4. The cost
is one extra index per parent table; the benefit is that the worst class of multi-tenant
bug cannot be written.

### 2. `model_configurations` — the buildable matrix

The spec's chain (model → powertrain → trim → options) implies every trim ships with
every engine. Real manufacturers don't work that way, and a configurator that lets you
build a car the factory doesn't make is a configurator nobody trusts.

`model_configurations` is the explicit set of offered powertrain × trim combinations,
each with its own resolved base price. Everything downstream hangs off it: colour
availability, option availability, features, inventory units, saved builds. It is the
single join target for "what can actually be built, and what does it cost".

### 3. `option_availability` carries `is_standard`

The same option is standard on Premium, a $2,400 extra on Core, and unavailable on Sport.
One row per (option, configuration) with `is_standard` and an optional price override.
This is what lets the configurator show "included" rather than charging twice, and lets
the AI answer "does the Premium already have that?" correctly.

### 4. Catalogue versus customer configuration are different tables

`model_configurations` is the manufacturer's product matrix — tenant catalogue data.
`saved_builds` is one visitor's chosen car. The spec names both `vehicle_configurations`
(§4/§6 vs §45); merging them would give the two different owners, lifetimes and
retention policies a single table. See `docs/04-spec-review.md` §7.

`saved_builds` stores a `price_breakdown` **snapshot**. When the dealership raises prices,
the build the customer saved last week must still show what they were quoted, and the
lead must record what they were told. Recomputing from current catalogue prices would
silently rewrite history.

### 5. `lead_signals` — evidence, separate from conclusions

`leads` holds the current best value of each field, for querying and display.
`lead_signals` holds every extracted value with its confidence, its source
(`ai | form | staff`) and the message it came from.

This is what makes §26 real rather than aspirational. It gives three things nothing else
gives: the scoring engine can weight an uncertain budget at less than a stated one; staff
can see *"budget $55k — from the customer's third message"* instead of an unsourced
number; and a corrected extraction supersedes rather than overwrites, so the audit trail
survives.

### 6. Appointments consume *resources*, not slots

A test drive occupies a salesperson **and** a demonstrator car. `appointment_resources`
links an appointment to each, with its own time range, and the exclusion constraint acts
per resource. Booking a car that is already out, or a salesperson already busy, both
fail the same way through the same mechanism.

There is deliberately **no `appointment_slots` table**. Availability is computed from
business hours minus closures minus booked ranges. Materialized slots drift; computed
slots cannot. See `docs/04-spec-review.md` §6.

The range is half-open `[)`, so a 12:15 booking directly after a 11:30–12:15 one is
legal. Closed ranges would reject every back-to-back appointment — a bug that looks like
"the calendar is mysteriously half empty". Verified as case T3.

### 7. Test drive holds are not sales reservations

`inventory_units.status = 'reserved'` means a customer is buying it. A test drive places
a time-bounded hold on the *vehicle resource* instead. Conflating them would take
demonstrators off the market every time someone booked a drive.

### 8. Customer-facing inventory is a view, not a filter

`v_public_inventory` exposes only `status = 'available'` and only public columns. The
customer site and the AI's `checkInventory` read it exclusively. Showing a sold car as
available then requires two independent mistakes rather than one forgotten `WHERE`.

### 9. Email is an outbox row inside the business transaction

`email_messages` is written in the same transaction as the booking. A rolled-back
booking cannot send mail; a provider outage delays mail without failing the booking; the
unique `dedupe_key` makes retries safe. Status advances `queued → accepted → delivered`
only on provider and webhook confirmation, which is what makes "never claim an email was
sent" enforceable rather than a prompt instruction.

### 10. Where JSON is and is not allowed

JSON is used for exactly four things: tenant settings blocks, scoring/follow-up rule
predicates, price breakdown snapshots, and provider webhook payloads. All are genuinely
tenant-variable, never joined, never filtered.

Everything operational — leads, appointments, inventory, tickets, signals — is
relational, indexed and constrained. Spec §45's warning against "one enormous JSON blob"
is right, and the line is drawn here.

---

## Entity relationships

```
tenants ─┬─ tenant_domains, tenant_settings, business_hours, business_closures
         ├─ staff_users ──────────────── resources(kind=staff)
         ├─ customers ─── visitors
         │       │
         │       ├─ leads ─┬─ lead_signals      (evidence + confidence)
         │       │         ├─ lead_events       (timeline)
         │       │         ├─ staff_notes       (internal only)
         │       │         └─ follow_up_tasks
         │       ├─ tickets ─── ticket_messages
         │       ├─ appointments ─── appointment_resources ─── resources
         │       ├─ finance_requests
         │       └─ trade_in_requests
         │
         ├─ conversations ─┬─ messages
         │                 └─ tool_invocations  (idempotency ledger)
         │
         ├─ vehicle_models ─┬─ powertrains ─┐
         │                  ├─ trims ───────┼─▶ model_configurations
         │                  ├─ colours ─────┤      │
         │                  └─ options ─────┘      ├─ colour_availability
         │                                         ├─ option_availability
         │                                         ├─ vehicle_features
         │                                         ├─ saved_builds
         │                                         └─ inventory_units
         │                                                 │
         │                                         resources(kind=vehicle)
         │
         └─ email_messages, notifications, job_queue, audit_logs, catalogue_events
```

---

## Indexing

Driven by the queries the Dealer Portal actually runs:

| Index | Serves |
|---|---|
| `leads (tenant_id, priority, status, last_activity_at DESC)` | dashboard: high-priority open leads |
| `leads (tenant_id, assigned_staff_id) WHERE status NOT IN ('won','lost')` | "my pipeline" |
| `leads (tenant_id, next_follow_up_at) WHERE NOT NULL` | follow-ups due |
| `appointments (tenant_id, starts_at) WHERE status IN ('scheduled','confirmed')` | today's diary |
| `inventory_units (tenant_id, model_configuration_id) WHERE status='available'` | customer availability |
| `conversations (tenant_id, last_message_at DESC)` | recent activity |
| `notifications (tenant_id, recipient_id, created_at DESC) WHERE read_at IS NULL` | unread badge |
| `job_queue (status, run_at) WHERE status='pending'` | worker claim |

Partial indexes throughout: the hot queries all filter on an open or active state, and
closed records dominate the table over time.

---

## Seed data (Phase 2)

Sinclair is inserted as tenant #1 by a seed script, not by migration. Ten models across
sedan, coupe, SUV, crossover and pickup, with model-appropriate trim naming (S-series
Core/Premium/Luxury; R-series Sport/Performance; E-series Range/Dual Motor), multiple
powertrains per model including ICE, hybrid and BEV, a realistic option catalogue with
package rules, ~40 inventory units across states, plus the demonstration customers,
conversations, leads, appointments and tickets from spec §43.

All seed people are clearly fictional. Sinclair's own catalogue, branding and imagery
are original — no real manufacturer's marks or photography. Trade-in records may name
real makes, as the spec's own examples do (§25, §44): a dealership genuinely does take a
BMW in trade, and naming it is ordinary factual use.
