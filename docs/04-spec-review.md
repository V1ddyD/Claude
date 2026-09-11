# Specification Review

Answering §63 items 2 and 15: contradictions, gaps, and what should change **before**
implementation starts. Each item states the problem, the recommendation, and the cost of
ignoring it.

---

## A. Genuine contradictions

### 1. Who decides lead priority?

§11 — *"The AI determines priority based on conversation evidence."*
§56 — *"Allow admins to configure lead scoring rules."*

Both cannot hold. If a model produces the band directly, the admin's rules are
decorative; if rules produce it, the model is not determining it.

**Recommendation.** Split the responsibility: the model extracts *evidence* with
per-field confidence; a tenant-configurable weighted rule engine converts evidence into
a score and band. Architecture §6.

**If ignored:** priority becomes unexplainable and untunable, drifts silently across
model versions, and cannot be regression-tested — which matters because this number
drives who a dealership calls first.

---

### 2. Confidence tracking is specified but has nowhere to live

§26 requires per-field confidence. §51's structured output example has none, and §45's
table list has no home for it — `leads` columns can hold a value but not a value plus
confidence plus provenance.

**Recommendation.** Add `lead_signals (lead_id, field, value jsonb, confidence, source,
extracted_from_message_id, superseded_at)`. Denormalize the current best value onto
`leads` for query speed, but keep `lead_signals` as the record of *how we know*. This
also gives staff "the customer said this, in this message" instead of an unsourced
assertion, and gives scoring its confidence-weighting input.

**If ignored:** confidence silently disappears in implementation, §26 goes unbuilt, and
staff cannot tell an inferred budget from a stated one.

---

### 3. Customer verification has no mechanism for the primary flow

§19 says to verify identity "using the available authentication/session mechanism", but
the headline flow (§44) is an anonymous stranger who gives a name and email mid-chat.
There is no session to verify against, and the spec does not say that an email is not
a credential.

**Recommendation.** Make the rule explicit and enforce it in code: *an email address or
phone number is an identifier, never an authenticator.* Three tiers — anonymous visitor
cookie (create only), authenticated customer account (full profile), scoped single-use
magic link (one ticket). Architecture §3.

**If ignored:** the obvious implementation is a `getCustomerProfile(email)` tool, which
is a customer-data enumeration endpoint operated by a chatbot. This is the most serious
security flaw latent in the specification.

---

### 4. Leads and tickets overlap without a stated relationship

§10 extracts lead fields including `ticket_number`; §20 says every request becomes a
ticket; §45 lists both as top-level entities. The relationship and cardinality are
never defined, and "sales enquiry" appears as both.

**Recommendation.** Define them as different things:
- **Lead** = the sales-pipeline relationship with a person. One per customer per active
  buying cycle. Carries priority, status, assignment.
- **Ticket** = one customer request, with a number and a lifecycle. Many per lead.
  Service tickets have `lead_id = NULL`.

Customer-visible: ticket number. Internal: lead.

**If ignored:** every request creates a duplicate "lead", the portal fills with
near-identical records for the same person, and assignment and priority become
meaningless.

---

### 5. The confirmation slip has no real date

§21's example renders `Date: Saturday`, `Time: 11:30 AM` — no date, no year, no
timezone.

**Recommendation.** Store `timestamptz`; render absolute local date, time and timezone
in every confirmation, email and slot offer (`Saturday 19 September 2026, 11:30 AM
EDT`). The relative word may accompany it, never replace it.

**If ignored:** a customer booking near midnight, travelling, or with a VPN-shifted
browser arrives on the wrong day. This is the single most common real-world booking bug.

---

### 6. `appointment_slots` as a table is the wrong model

§45 lists a slots table. Materialized slots must be generated ahead, regenerated when
hours, closures, staff or durations change, and pruned — and they drift.

**Recommendation.** Compute availability from business hours minus closures minus booked
resource ranges. Keep no slot table. Architecture §7.

**If ignored:** a class of bugs where the calendar offers times the dealership is closed,
or hides times it is open, with no obvious cause.

---

### 7. `vehicle_configurations` means two different things

In §4/§6 it is a customer's chosen build; in §45 it sits among catalogue tables. These
have different owners, lifetimes and tenancy.

**Recommendation.** Two tables: `model_configurations` (catalogue — which powertrain ×
trim combinations the manufacturer actually offers, with resolved price) and
`saved_builds` (a visitor's or customer's configuration, with a price snapshot).

**If ignored:** customer builds and the product matrix share a table, and the
configurator cannot answer "is this combination even offered?" — which it must, because
not every trim ships with every engine.

---

### 8. "Do not invent taxes or fees" versus a finance calculator

§6 forbids inventing fees; §40 wants monthly payment estimates, which in reality depend
on tax, registration and doc fees.

**Recommendation.** Compute strictly from configured values: vehicle price, down
payment, term, and an APR that is either tenant-configured or user-entered. Label output
"Estimate — excludes taxes, registration and dealer fees. Not a financing offer." Add an
optional tenant fee schedule later, off by default.

**If ignored:** either the estimate is wrong by thousands, or the app invents fees the
dealership never agreed to — a genuine legal exposure.

---

## B. Gaps — required but unspecified

### 9. Timezone handling is never stated

Only §30 mentions timezone, as a setting. Nothing says how it is applied.

**Recommendation.** All timestamps `timestamptz`. All business-hours arithmetic in the
tenant's IANA zone. All customer-facing times rendered with zone. Never store a naive
local time.

---

### 10. Conversation retention and PII lifecycle

§31 covers consent but not retention. Conversations contain names, phone numbers,
budgets and trade-in details indefinitely.

**Recommendation.** Per-tenant retention policy (default: 24 months for conversations,
longer for transactional records), a scheduled redaction job, and a customer data
export/erasure path. Decide the default before launch, not after the first request.

---

### 11. AI cost control is absent

Nothing in the spec bounds spend. A public, unauthenticated chat endpoint calling a
frontier model is an open cost surface.

**Recommendation.** Per-visitor and per-IP rate limits; a per-tenant monthly token
budget with a degraded mode (catalogue browse + contact form) rather than a hard outage;
prompt caching for the stable prefix; bounded tool-call loops; token usage recorded per
conversation for per-tenant billing later.

---

### 12. Staff and customers share one auth pool

Both audiences land in `auth.users`. The spec never addresses the escalation path.

**Recommendation.** Portal authorization requires an active `staff_users` row —
membership in `auth.users` grants nothing. Staff accounts are invite-only; public
signup can never create one. Add a CI test that asserts a customer session receives 403
on every portal route.

---

### 13. Idempotency is required but its key is undefined

§33 demands that retrying a test drive creation not double-book, without saying what
makes two requests "the same".

**Recommendation.** `idempotency_key = hash(conversation_id | tool_name | normalized
input)` for AI-originated writes, and a client-generated UUID header for form
submissions. Unique index; replay returns the stored result.

---

### 14. No definition of "dealership response time"

§15 and §21 promise the customer that someone will follow up, without a stated window.

**Recommendation.** Tenant setting `response_sla_hours` per department, surfaced in the
customer's confirmation ("a specialist will contact you within 1 business hour") and
used as the follow-up rule trigger. Never promise a window the dealership has not set.

---

### 15. Vehicle imagery is assumed to exist

§35 and §38 require consistent hero images and galleries for a fictional brand.

**Recommendation.** Treat imagery as a real deliverable with an owner and a decision
before Phase 6. Options: licensed stock, generated renders, or a deliberately
photography-light editorial design built around typography, spec tables and silhouette
illustration. The third is the honest default if no asset budget exists, and can be
made to look genuinely premium. What must not happen is placeholder grey boxes shipping
into the demo.

---

### 16. "Popular configurations" analytics needs events that nothing records

§42 wants popular models, trims and configurations. Nothing in the data model captures
configurator interactions that don't become leads.

**Recommendation.** A lightweight, tenant-scoped `catalogue_events` table
(`visitor_id, event, model_id, payload`) written from the configurator and detail pages.
Cheap now, impossible to backfill later.

---

## C. Changes recommended to the build order

### 17. The phase order defers the riskiest integration too long

§59 builds the full website (Phase 6) and configurator (Phase 7) before the AI assistant
(Phase 8) and the portal (Phase 11). The AI-to-lead-to-portal path is where the product
is won or lost, and it would be validated last.

**Recommendation.** Insert a **walking skeleton** after Phase 3: one ugly page, one
model, one working tool call, one lead, one portal row. It proves the spine end to end
in days, and every later phase fills in a slice that already has a known-good shape.
Full ordering in [`docs/05-roadmap.md`](05-roadmap.md).

---

### 18. n8n should not be adopted in v1

§47 offers it "if genuinely useful". For the automations described — follow-ups,
notifications, reminders — it is not: they are database-triggered jobs needing
tenant-scoped authorization, which is exactly what an external workflow engine makes
harder to audit.

**Recommendation.** Postgres-backed job queue in-app. Revisit when dealerships want to
author their own integrations.

---

### 19. The catalogue needs one more level than the spec implies

§4's chain (model → powertrain → trim → options) implies every trim is offered with
every powertrain. Real manufacturers don't work that way: the base engine usually isn't
offered on the top trim, and some options are standard on one trim and optional on
another.

**Recommendation.** Add `model_configurations` as the buildable matrix, and
`option_availability (option, configuration, is_standard, is_available)`. This is what
makes the configurator feel like a real manufacturer's rather than a price calculator —
and it is much cheaper to build in now than to retrofit.

---

## D. Things the spec gets right and should not be "improved"

Worth stating, because these are the parts most likely to get eroded during
implementation:

- **The AI never writes to the database directly** (§52). Non-negotiable.
- **Priority is invisible to customers** (§11, §54).
- **Never claim an email was sent until the provider confirms** (§21). This single
  sentence forces the outbox design and is worth its cost.
- **Don't dump the database into the reply** (§7). The most common failure of AI
  assistants, correctly identified.
- **Don't build fake functionality to make the UI look complete** (§60). Applied here:
  Phase 0 ships documents, not a scaffold that pretends to work.
