# System Architecture

Status: proposed, Phase 0. Nothing here is implemented yet.

---

## 1. Shape of the system

```
          ┌──────────────────────────┐     ┌──────────────────────────┐
          │   Customer website       │     │    Dealer Portal         │
          │   (public, anonymous)    │     │    (staff, authenticated)│
          │   /                      │     │    /portal               │
          └────────────┬─────────────┘     └────────────┬─────────────┘
                       │  fetch / server actions        │
          ┌────────────▼────────────────────────────────▼─────────────┐
          │                    Next.js server layer                    │
          │  route handlers · server actions · middleware · authz      │
          └────────────┬───────────────────────────────┬──────────────┘
                       │                               │
          ┌────────────▼─────────────┐     ┌───────────▼──────────────┐
          │  AI orchestrator         │     │  Domain services         │
          │  · conversation loop     │────▶│  catalogue · pricing     │
          │  · tool registry         │     │  inventory · leads       │
          │  · extraction pass       │◀────│  booking · tickets       │
          └────────────┬─────────────┘     │  finance · email         │
                       │                   └───────────┬──────────────┘
                       │                               │
                       │                   ┌───────────▼──────────────┐
                       └──────────────────▶│  Repositories (Drizzle)  │
                                           │  tenant-scoped, only way │
                                           │  to touch the database   │
                                           └───────────┬──────────────┘
                                                       │
                                   ┌───────────────────▼──────────────────┐
                                   │  PostgreSQL   ·   RLS backstop        │
                                   └───────────────────┬──────────────────┘
                                                       │
                     ┌─────────────────────────────────▼────────────────────┐
                     │  Job queue → worker: outbox email, follow-ups,       │
                     │  lead extraction, notifications, reminders           │
                     └──────────────────────────────────────────────────────┘
```

The single most important structural rule:

> **The AI orchestrator is a peer of the UI, not a peer of the database.**
> It calls the same domain services the Dealer Portal calls. It has no privileged path.

This is what prevents the classic failure mode where the chatbot can do things the
UI cannot, or bypasses validation the UI enforces.

### Why one Next.js deployment and not two apps

The spec calls the website and the portal "separate applications/interfaces". They are
separate *interfaces* with separate auth, separate layouts and separate authorization —
but splitting them into two deployments now buys nothing and costs a shared-code
build pipeline, a second deploy target and a network hop for every portal query.

Instead: **one deployment, two route groups, one server layer.**

```
src/app/(site)/**     → customer website, no session required
src/app/(portal)/**   → Dealer Portal, staff session required
src/app/api/**        → route handlers (chat stream, webhooks, cron)
```

Because all logic sits in `src/server/`, splitting the portal into its own deployment
later is a routing change, not a rewrite. That optionality is the thing worth
preserving, not the split itself.

**Isolation is enforced, not assumed.** `middleware.ts` rejects unauthenticated
requests to `/portal/*` before they render, and *every* portal server action and
loader independently calls `requireStaff(permission)`. Middleware is a convenience;
it is never the authorization boundary. A portal route that forgets its own check is
a bug that CI should catch (see §14).

---

## 2. Multi-tenancy

Sinclair is tenant #1. Nothing about the code knows the word "Sinclair" outside seed
data and test fixtures.

### Tenant resolution

| Surface | How the tenant is determined |
|---|---|
| Customer website | Hostname → `tenant_domains.hostname`. Fallback: `DEFAULT_TENANT_SLUG` in dev. |
| Dealer Portal | `staff_users.tenant_id` for the authenticated user. **Never** from the URL. |
| API / webhooks | Signed payload or the tenant of the referenced entity. Never a query param. |
| Cron / worker | Iterates tenants explicitly. |

The customer's tenant comes from the host; the staff member's tenant comes from their
identity. Neither is ever accepted from client input — that is the entire attack.

### Isolation, three layers deep

1. **Schema.** Every tenant-owned table carries a non-null `tenant_id uuid` with an FK
   to `tenants`. Composite FKs carry `tenant_id` so a child can never point at a parent
   in another tenant. Every tenant-scoped unique index is `(tenant_id, …)`.

2. **Application.** There is no naked `db` export. Request handling opens a transaction,
   sets `SET LOCAL app.tenant_id = $1`, and hands the caller a `TenantDb`. Repositories
   accept `TenantDb`, never a raw client. A query without a tenant context cannot be
   written without deliberately importing the admin client, which lives in one file and
   is lint-banned everywhere else.

3. **Database.** RLS is enabled on every tenant table with
   `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`. The application
   connects as a role that is *not* the table owner and does *not* have `BYPASSRLS`.
   If layer 2 is ever bypassed by a bug, the database returns zero rows rather than
   another dealership's customers.

Layer 3 matters specifically because this app uses a server-side connection. Supabase
RLS protects browser-direct access; here it must be driven by the GUC or it protects
nothing. Note the consequence: **the service-role key is never used for request-path
queries.** It is reserved for migrations and the tenant-provisioning path.

### What is and is not tenant-scoped

- Tenant-scoped: customers, leads, conversations, inventory, appointments, tickets,
  staff, notes, audit logs, settings, **and the vehicle catalogue**.
- Global: `tenants`, `tenant_domains`, `role_permissions`, migration metadata.

The catalogue is tenant-scoped from day one even though Sinclair's models are
"the manufacturer's". Spec §46 anticipates shared catalogue templates later; the
migration path is a nullable `source_template_id` on catalogue rows plus a copy-on-
onboard step. Making the catalogue global now and tenant-scoping it later is a far
worse migration than the reverse.

---

## 3. Authentication and authorization

Two audiences with genuinely different requirements.

### Staff

Supabase Auth (email + password, MFA-capable) issues the session. **Authentication is
not authorization**: a valid `auth.users` session grants nothing. Portal access requires
an active row in `staff_users` keyed by the auth user id, carrying `tenant_id` and
`role`. A customer who signs up on the public site therefore cannot reach the portal
even though they exist in the same auth pool.

```
requireStaff(perm) →
  session? → staff_users row? → status = 'active'? → role has perm? → TenantDb
  any failure → 403, audit-logged, no detail leaked to the client
```

Roles and permissions are data, not `if` statements:

| Permission | SALES | SERVICE | MANAGER | ADMIN |
|---|:-:|:-:|:-:|:-:|
| `lead.read.assigned` | ✓ | | ✓ | ✓ |
| `lead.read.all` | | | ✓ | ✓ |
| `lead.assign` | | | ✓ | ✓ |
| `lead.status.write` | ✓ | | ✓ | ✓ |
| `customer.read` | ✓ | ✓ | ✓ | ✓ |
| `customer.pii.export` | | | ✓ | ✓ |
| `appointment.write` | ✓ | ✓ | ✓ | ✓ |
| `ticket.sales.*` | ✓ | | ✓ | ✓ |
| `ticket.service.*` | | ✓ | ✓ | ✓ |
| `inventory.status.write` | | | ✓ | ✓ |
| `inventory.price.write` | | | | ✓ |
| `analytics.read` | | | ✓ | ✓ |
| `audit.read` | | | | ✓ |
| `settings.write` | | | | ✓ |
| `staff.manage` | | | ✓* | ✓ |

`*` managers may invite/deactivate SALES and SERVICE only.

Row-level scoping rides on top: `lead.read.assigned` filters to
`assigned_staff_id = me OR assigned_staff_id IS NULL`.

### Customers

The product's central flow is a stranger opening a chat. Requiring an account first
would kill it. So:

- **Visitor session.** First request mints an opaque `visitor_id` in a signed,
  httpOnly, SameSite=Lax cookie. Conversations, saved builds and page views attach to
  it. No PII required.
- **Lazy customer record.** When the visitor supplies an email or phone (naturally, in
  conversation), a `customers` row is created or matched within the tenant, and the
  visitor is linked. This is an *identifier*, not a credential.
- **Authenticated customer (optional).** Supabase Auth + a `customer_profiles` row.
  Required to browse full profile history.
- **Scoped magic link.** To let an unauthenticated customer view *one* ticket or
  appointment, email a single-use, expiring, ticket-scoped token. This is the only
  way an unauthenticated party ever sees stored data.

> **Rule: an email address or phone number is never proof of identity.** Nothing —
> not the AI, not a support form — may retrieve a customer's record because someone
> typed their email. Spec §19 is ambiguous here; this resolves it. See
> `docs/04-spec-review.md` §3.

---

## 4. The AI layer

### Request flow

```
POST /api/chat  (Node runtime, streaming)
  ├─ resolve tenant (host) + visitor (cookie)
  ├─ rate limit: per visitor, per IP, per tenant
  ├─ load conversation window (recent turns + pinned facts, not the whole history)
  ├─ build system prompt: tenant AI settings + catalogue digest + hard rules
  ├─ Claude loop:
  │     assistant → tool_use? → registry.dispatch(ctx, name, input) → tool_result → repeat
  │     (bounded: max tool calls per turn, max wall clock, max tokens)
  ├─ stream text to the customer
  └─ enqueue job: extract_and_score(conversation_id)   ← asynchronous, off the hot path
```

### Two assistants behind one interface

`AI_PROVIDER` selects one — `scripted`, `anthropic`, or `auto` (the model when a
credential exists, the scripted assistant when none does). `features.aiProvider` resolves
it in one place; nothing else reads the variable or checks for a key, so there is no
second opinion about which assistant is running. Selecting `scripted` never requires a
credential; selecting `anthropic` without one fails at boot rather than in front of a
customer.

`ModelClient` has two implementations, and nothing downstream of `modelClient()` knows
which one it has:

| | `AnthropicModelClient` | `RuleBasedModel` |
|---|---|---|
| Decides what to say | Claude Opus 5 | `src/server/ai/rule-based/` |
| Tools it can call | the registry | the registry |
| Services, scoring, tickets, email | identical | identical |
| Cost per turn | metered | none |
| Selected when | a credential is configured | no credential, or the tenant's budget is spent |

The rule-based assistant classifies the message, extracts what it can, calls the same
tools, and composes its reply out of what they returned. It never states a figure a tool
did not return, and when it does not recognise a question it says so and offers the
team — the same three states the prompt asks the model to keep distinct.

It exists for two reasons. The site works out of the box, with no key and no contact
form; and the whole workflow — booking, consent, ticketing, lead scoring, the portal —
can be exercised end to end deterministically, which a model cannot be asked to do.

What it is not: an understanding of language. It matches patterns. A question phrased
unusually falls through to the honest "I do not have that confirmed" and a ticket, which
is the right failure but a visibly plainer experience than the model gives.

#### It contains no catalogue

This is what separates it from a demo script. There is no list of model names, trim
names, colour names or engine codes anywhere in `src/server/ai/rule-based/`:

- **Models** come from the catalogue digest the tenant's own range produced, matched on
  slug, full name and the name after the brand — so "s5", "Sinclair S5", "the S5" and
  "S5s" are one car, and a model added to the catalogue is understood on the next
  request.
- **Trims, colours and powertrains** are never guessed at. The customer's words are
  captured loosely and resolved strictly (`resolve.ts`) against the rows a tool actually
  returned, scored by how much of a row's name they used. A word that names nothing
  resolves to nothing and is dropped.
- **Colour words** are the one language-level list — "green", "burgundy" — used only to
  notice that a colour was mentioned. Which colours exist, what they are called and what
  they cost all come from the catalogue.

The consequence is that a second dealership with an entirely different range works
without a line of change, and the test suite proves it: `scripted-coverage.test.ts`
enumerates whatever is in the database and asks the same questions of each model, and
`scripted-tenant-isolation.test.ts` shows the second tenant's assistant does not
recognise the first tenant's model names at all.

#### Extraction without a model

Pass B runs deterministically too (`rule-based/signals.ts`). It produces the same
`LeadSignals` contract the model fills in, validated by the same schema, applied through
the same `applySignals`, and scored by the same rule engine — the extract/score split is
untouched (spec §11, §16). Confidence is the honest part: everything it records was
either stated outright (0.95) or observed by the system (1.0), because it infers nothing.
Configuration codes are resolved against the catalogue rather than trusted from the
customer's wording, so a trim the dealership does not sell is recorded as nothing.

What a scripted lead lacks is implication — a budget hinted at rather than stated, a
timeframe read from tone. That is thinner, not wronger.

### Two passes, deliberately separate

**Pass A — the conversational agent.** Answers the customer, calls tools. Its context
contains only customer-safe data. It has never seen a lead score, a staff note, or an
internal summary, so it cannot leak one.

**Pass B — the extraction and scoring pass.** Runs as a queued job after the turn.
Re-reads the conversation, emits a strictly validated `LeadSignals` JSON (forced via a
structured-output tool + Zod), updates the lead, recomputes priority, writes the
internal summary, fires automations.

Why separate rather than one clever prompt:

- **Latency.** The customer waits for Pass A only.
- **Leak prevention by construction.** Internal state lives in a model context the
  customer can never reach. This is stronger than instructing a model not to reveal it.
- **Determinism.** Pass B runs at low temperature against a fixed schema and can be
  replayed, diffed and regression-tested against recorded conversations.
- **Failure isolation.** If extraction fails, the customer conversation is unaffected;
  the job retries.

### Context management

Never send the database to the model. Per turn the context is:

1. System prompt — tenant identity, tone, hard rules, current date/time in tenant tz.
2. A small **catalogue digest** — model names, body styles, price-from. Enough to route
   a question, not enough to answer one. Everything specific comes from tools.
3. A **pinned facts block** — the structured signals already extracted (chosen model,
   trim, colour, budget, timeframe). This is how "how much is the Premium?" resolves to
   the S5 three turns later without replaying the transcript.
4. The last N message pairs verbatim; older turns as a rolling summary.

The system prompt and catalogue digest are stable and prompt-cached.

### Grounding

The assistant may state a specification, price, availability, slot or dealership fact
**only** if it came from a tool result in the current turn. Tool results are rendered
into the context with explicit provenance and an `as_of` timestamp. If no tool returns
the fact, the correct behaviour is to say so and offer a human — never to infer it from
training data. Three states must stay distinguishable in the reply: *confirmed*,
*estimated* (finance figures, trade-in ranges), *unavailable*.

---

## 5. AI tool architecture

Tools are declared once in TypeScript and derive everything else:

```ts
export const checkInventory = defineTool({
  name: 'checkInventory',
  scope: 'read',
  summary: 'Units physically available for a model/trim/colour at this dealership.',
  input: z.object({
    modelSlug: z.string(),
    trimCode: z.string().optional(),
    exteriorColourCode: z.string().optional(),
    limit: z.number().int().min(1).max(5).default(3),
  }),
  handler: async (ctx, input) => inventoryService.findAvailable(ctx, input),
});
```

Five properties are non-negotiable:

1. **`tenant_id`, `visitor_id`, `customer_id` and `conversation_id` are never tool
   parameters.** They are injected from `ToolContext`, built server-side from the
   session. The model cannot express "look at another dealership" because there is no
   field in which to say it. This is the single most important piece of the AI security
   model.

2. **No SQL reaches the model, ever.** There is no `runQuery` tool, no filter DSL, no
   free-text `where`. Every tool is a fixed question with typed parameters.

3. **Results are projected, not dumped.** Each tool returns a hand-written
   customer-safe DTO: field whitelists, row caps, money as formatted strings plus
   minor units, and no internal fields — no cost, no floorplan age, no lead data, no
   staff identity beyond a first name. A leak in the projection layer is the only way
   internal data reaches a customer, so that layer is small, explicit and unit-tested.

4. **Write tools are idempotent.** Key = `hash(conversation_id, tool_name, normalized
   input)` stored with a unique index in `tool_invocations`. A retried or duplicated
   call returns the stored result. Spec §33 requires retrying a booking not to produce
   two appointments; this is how.

5. **Write tools validate business rules server-side.** The model *requests*; the
   service *decides*. `createTestDrive` re-checks opening hours, closures, resource
   conflicts and inventory state inside the booking transaction. A model that asks for
   an invalid slot gets a typed error and alternatives, not an appointment.

Full contracts in [`docs/03-ai-tools.md`](03-ai-tools.md).

### Prompt injection posture

Customer text is untrusted input, and the catalogue may one day carry
dealer-authored copy. Mitigations: customer text is never concatenated into the system
prompt; tool inputs are schema-validated so injected text cannot become a new
parameter; there are no destructive tools (no delete, no price write, no status
override); and every write is authorized against the *visitor's* context, so the worst
case of a successful injection is a spurious lead in the visitor's own conversation.

---

## 6. Lead scoring

The spec says the AI determines priority (§11) and that admins configure scoring rules
(§56). Those cannot both be literally true. The resolution:

> **The model extracts evidence. A deterministic, tenant-configurable rule engine
> turns evidence into priority.**

```
conversation
   └─ Pass B extraction ──▶ LeadSignals { field, value, confidence, source, message_id }
                                │
                                ▼
                     lead_scoring_rules (per tenant, weighted)
                                │
                                ▼
                    score 0-100 ──▶ bands ──▶ LOW | MEDIUM | HIGH
                                │
                                ▼
                    rationale built from the rules that fired
```

Default rule set (weights are seed data, editable in the portal):

| Signal | Weight |
|---|--:|
| Test drive requested with a date | 25 |
| Specific configuration (model + trim + powertrain) | 15 |
| Purchase timeframe ≤ 30 days | 20 |
| Purchase timeframe 1–3 months | 12 |
| Budget stated and within a model's range | 10 |
| Finance readiness stated | 10 |
| Trade-in offered | 8 |
| Asked about availability of a specific unit | 8 |
| Asked to speak to a salesperson | 15 |
| Price negotiation language | 10 |
| Returning visitor, ≥3 sessions | 6 |
| Explicit "just browsing" / "next year" | −20 |

Bands: `HIGH ≥ 60`, `MEDIUM ≥ 30`, else `LOW`. Confidence below a per-field threshold
contributes at reduced weight instead of full weight — an uncertain budget should not
manufacture a hot lead.

Why not let the model output the priority directly:

- It would be unexplainable and untunable; §56 requires tunability.
- It would drift between model versions with no regression signal.
- Rules are testable: a fixture corpus of conversations with expected bands runs in CI.

The model does keep one narrow input: it may propose an adjustment of ±10 with a
one-sentence justification, recorded separately and applied only if the tenant enables
it. That captures judgment a rule table misses without surrendering control of the
outcome.

The rationale shown to staff is assembled from fired rule descriptions — *"High
priority: specific configuration selected, purchase timeframe within 1–2 months, test
drive requested for Saturday."* It is a statement of evidence, not chain of thought,
which satisfies §11's "do not expose hidden reasoning".

**Priority and status are orthogonal** (§12). Priority is computed and recomputed by
the system. Status is owned by staff and only ever changed by a human action, recorded
in `lead_events` with actor and timestamp.

---

## 7. Appointments and conflict prevention

This is the part most likely to be quietly wrong, so it is solved at the database level.

### No materialized slot table

Spec §45 lists `appointment_slots`. I recommend against it. Materialized slots drift
out of sync with hours, closures and staff changes, and need regeneration jobs. Instead,
availability is **computed**:

```
available(date range, type) =
    business_hours(tenant, department, weekday)
  − business_closures(tenant, date)
  − existing appointment_resources time ranges (for eligible resources)
  ÷ slot_duration (tenant setting, per appointment type)
  ∩ [now + min_notice, now + max_horizon]
```

Cheap to compute, impossible to desynchronize. See `docs/04-spec-review.md` §6.

### Resources

A test drive consumes *two* scarce things: a person and a car. The spec doesn't say
which is constrained; both are. `appointment_resources` links an appointment to one or
more `resources` (`kind ∈ staff | vehicle | bay`), each with its own time range.

### The guarantee

```sql
ALTER TABLE appointment_resources
  ADD CONSTRAINT appointment_resources_no_overlap
  EXCLUDE USING gist (
    tenant_id    WITH =,
    resource_id  WITH =,
    time_range   WITH &&
  ) WHERE (status = 'active');
```

Double booking is not prevented by a check-then-insert — it is **impossible**, enforced
by Postgres under concurrency. Two customers racing for the same 11:30 Saturday slot:
one insert commits, the other raises `23P01`, is caught, and returns
`SLOT_TAKEN` with three alternative times. The customer sees a graceful re-offer; the
AI never claims a booking that did not commit.

Booking is one transaction: create/attach lead → insert appointment → insert resource
rows (constraint fires here) → create ticket + number → enqueue confirmation email →
enqueue staff notification → write audit rows. All or nothing.

Every timestamp is `timestamptz`. All business-hours arithmetic happens in the tenant's
IANA timezone. Slot offers are rendered to the customer with an explicit date and
timezone-aware time — never "Saturday" alone (see `docs/04-spec-review.md` §5).

---

## 8. Inventory

States: `available → reserved → pending_delivery → sold`, plus `service_hold` and
`unavailable`. Transitions are declared in a table and validated in one function; the
UI and the AI cannot invent a path.

- **Customer-visible availability is a view**, `v_public_inventory`, which exposes only
  `available` units and only public columns. The AI's `checkInventory` reads that view
  and nothing else, so a sold car cannot be shown as available even if a projection
  elsewhere is buggy.
- **Only `inventory.status.write` holders change state.** The AI has no inventory write
  tool at all. It can create a *reservation request* ticket; a human confirms.
- **Optimistic concurrency.** `version` column, `UPDATE … WHERE version = $n`; a losing
  writer gets a 409 and re-reads.
- **A test drive does not reserve a unit for sale.** It places a time-bounded hold via
  `appointment_resources` on the vehicle resource. Conflating the two would take demo
  cars off the market.
- **Reservations expire.** `reserved_until`; the worker releases lapsed holds and
  audit-logs the release.

The AI may never promise a specific car without a live `v_public_inventory` hit in the
same turn.

---

## 9. Tickets and email

### Tickets

Every customer-initiated request produces a ticket, which is the customer's receipt and
reference. A lead is the *sales pipeline* entity; a ticket is the *request* entity. One
lead accumulates many tickets; service tickets have no lead at all. The spec blurs
these (§10 vs §20) — see `docs/04-spec-review.md` §4.

Numbering: `{PREFIX}-{YYYY}-{SEQ}` → `SIN-2026-10482`. Prefix, padding and reset period
are tenant settings. Allocation is a row-locked counter in `ticket_sequences`, obtained
inside the creating transaction, so numbers are gapless per tenant and never collide.
Sequences are per-tenant, so two dealerships never see each other's volume.

### Email — transactional outbox

The requirement "never claim an email was sent until the provider confirms" (§21, §54)
dictates the design:

```
business transaction
  └─ INSERT email_messages (status='queued', dedupe_key unique)   ← same transaction
                                   │
                              worker drains
                                   │
                     provider accepts → status='accepted' (+ provider id)
                     provider rejects → status='failed', retry w/ backoff
                                   │
                          provider webhook
                                   │
                     delivered | bounced | complained
```

Consequences, all of them intentional:

- Email can never be sent for a transaction that rolled back.
- A provider outage delays mail; it does not fail the booking.
- `dedupe_key` makes retries safe.
- The confirmation UI says **"Confirmation email queued to a@b.com"** and updates to
  "sent" when the provider accepts. The AI says "I've booked it — a confirmation is on
  its way to a@b.com" and never asserts delivery.
- Customers never see `email_events`; staff with the right permission do.

Email requires a valid address **and** recorded contact consent (§31). No consent, no
send — the ticket number is still shown on screen.

---

## 10. Background work

One Postgres-backed queue (`job_queue`) drained by an authenticated cron-invoked route.
Job kinds: `extract_and_score`, `send_email`, `evaluate_follow_ups`, `expire_holds`,
`notify_staff`, `refresh_lead_summary`.

Properties: `run_at` for scheduling, `attempts` + exponential backoff, `locked_by` /
`locked_at` with `FOR UPDATE SKIP LOCKED`, a dead-letter state, and per-job
idempotency. Failures are visible in the portal to admins rather than silent.

**Recommendation: do not adopt n8n for v1.** The spec offers it as optional (§47). Every
automation here is a database-triggered job with tenant-scoped authorization; routing it
through an external workflow engine adds a deployment, a second secret store and a
tenant-isolation boundary that is hard to audit, in exchange for a visual editor nobody
on this project needs yet. Revisit when dealerships want to author their own
integrations.

---

## 11. Follow-ups (§14)

Rules are tenant-configurable rows, not code:

| Rule | Trigger | Default delay | Action shown to staff |
|---|---|---|---|
| High-priority untouched | HIGH lead, no staff event | 2h (business hours) | "Call — high priority, no contact yet" |
| Test drive tomorrow | appointment T−24h | — | "Confirm tomorrow's test drive" |
| Callback requested | callback ticket open | 1h | "Customer requested a callback" |
| Quote sent, silent | proposal_sent, no reply | 3 days | "Follow up on proposal" |
| Lead dormant | no activity | 7 days | "Re-engage or move to Nurture" |

These create **staff tasks**, never automatic customer messages. Spec §14 is explicit
that the system should not spam customers, and automated outbound messaging on a
dealership's behalf is a reputational and legal liability that must stay a human
decision (or an explicit, separately-consented opt-in).

---

## 12. Human handoff (§15)

Triggers: explicit request for a person; negotiation or discount language; complaint
or dissatisfaction; the assistant lacking a grounded answer twice on the same topic;
financing application; trade-in valuation; anything service-technical; repeated
extraction failure.

On trigger: upsert the lead → set `handoff_requested_at` → create a ticket →
notify the right role → tell the customer plainly what will happen and when, within the
dealership's stated response window. The assistant continues to be useful for factual
questions but stops trying to close. It never implies a human has already replied.

---

## 13. Security model

| Control | Implementation |
|---|---|
| Secrets | Server-only env vars. `ANTHROPIC_API_KEY` is read in `src/server/ai/**` only; a lint rule bans server-secret imports from client components, and CI greps the client bundle for key prefixes. |
| Authorization | Server-side on every entry point. Middleware is not a boundary. |
| Tenant isolation | `tenant_id` + per-request GUC + RLS, three independent layers. |
| Input validation | Zod at every boundary: forms, route handlers, tool inputs, webhooks. |
| SQL injection | Parameterized queries only; the AI has no query surface. |
| Rate limiting | `/api/chat` per visitor + IP + tenant; auth endpoints per IP; write tools per conversation. Per-tenant monthly AI token budget with degraded-mode fallback. |
| Webhooks | Signature verification (email provider, Supabase) before parsing. |
| Audit | Append-only `audit_logs`: actor, action, entity, before/after, request id, hashed IP. No `UPDATE`/`DELETE` grant on the table. |
| Errors | Typed domain errors → safe customer-facing messages. Stack traces to the server log only, correlated by request id. |
| PII | Minimized by design; no payment card data ever; passwords are the auth provider's problem (never ours); export/erasure paths for §31. |
| Transport | HTTPS only, HSTS, httpOnly + SameSite cookies, CSP. |

Open item to decide before Phase 4: whether portal access requires MFA for MANAGER and
ADMIN. Recommendation: yes, once more than one tenant exists.

---

## 14. Testing strategy (§57)

Three tiers, all in CI:

1. **Unit** — pricing maths, scoring rules, slot computation, state machines, DTO
   projections. Pure functions, no database.
2. **Integration** (real Postgres, per-test transaction) — booking under concurrency
   (parallel clients racing one slot, asserting exactly one winner), inventory
   transitions, ticket numbering, outbox behaviour, idempotency replay.
3. **Tenant isolation suite** — a dedicated, non-skippable suite that asserts, for
   *every* tenant-scoped table, that tenant B's context cannot read or write tenant A's
   rows, with RLS proven independently by running the same assertions with the
   application layer deliberately bypassed.

Plus an **AI evaluation corpus**: recorded conversations with expected intents,
expected tool calls, expected extracted signals and expected priority band. Run on
every prompt or rule change. Grounding is asserted negatively too — ask about a colour
or model that doesn't exist and assert the reply declines rather than invents.

---

## 15. Deployment

Vercel (or any Node host) + Supabase Postgres + a transactional email provider.
Environments: `local` → `preview` (per PR, seeded) → `production`. Migrations are
versioned SQL in `db/migrations`, applied in CI before deploy, forward-only.

Runtime notes: `/api/chat` uses the Node runtime and streams; middleware stays on Edge
and does nothing but redirect. Long work belongs to the queue, never to a request.

---

## 16. Contradictions and recommended spec changes

Answered in full in [`docs/04-spec-review.md`](04-spec-review.md).
