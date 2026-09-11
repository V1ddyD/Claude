# Operations Runbook

How to deploy this, run it, and understand it when something breaks.

---

## Deploying

Three things are needed: a Postgres database, a host that runs Node, and a transactional
email provider. Nothing here is specific to a particular vendor; Supabase, Vercel and
Resend are what the configuration assumes.

### 1. Database

```bash
DATABASE_ADMIN_URL=postgres://owner@host/db npm run db:migrate
```

Migrations are forward-only and checksum-pinned: an applied migration that has since been
edited fails loudly rather than drifting. `0002` creates the `app_user` role and refuses
to proceed if it is superuser or `BYPASSRLS`, because tenant isolation depends on it
being neither.

**Two connection strings, two privileges.** This is not optional:

| Variable | Role | Used for |
|---|---|---|
| `DATABASE_URL` | `app_user` — not the owner, subject to RLS | Every request |
| `DATABASE_ADMIN_URL` | owner | Migrations, seeding, onboarding only |

Handing the request path an owner connection would silently disable tenant isolation
while every test still passed.

### 2. Environment

Copy `.env.example`. The one that matters most:

```
ANTHROPIC_API_KEY=sk-ant-...
```

The operator's key, set once, server-side. Customers never supply, see, or are asked for
one — enforced by a lint rule, a test, and a CI grep of the built client bundle.

Absent, the assistant degrades to a contact form and says so honestly. The site stays up.

### 3. The scheduler

`vercel.json` calls `/api/cron/worker` every five minutes, authenticated by `CRON_SECRET`.
That one call drives everything asynchronous:

| Job | What it does |
|---|---|
| `extract_and_score` | Turns the conversation into lead evidence and a priority |
| `send_email` | Drains the outbox to the provider |
| `evaluate_follow_ups` | Raises staff tasks for leads going cold |
| `expire_holds` | Returns lapsed reservations to the market |
| `apply_retention` | Redacts conversations past the retention window |
| `sweep_rate_limits` | Removes closed rate-limit windows |

Without the scheduler running, the site works and bookings commit — but no email is
sent, no lead is scored, and no follow-up appears. **If the portal looks empty, check the
cron first.**

---

## Onboarding a dealership

```bash
npm run onboard -- dealerships/northwind.example.json
```

That is the whole process. No code change, no migration, no deploy —
`tests/integration/onboarding.test.ts` brings up a dealership on a different timezone,
currency, locale and ticket series to prove it.

Point the hostname at the deployment and it serves that dealership. The catalogue is
seeded separately, the same way Sinclair's is.

---

## When something is wrong

### "The site says it is not available"

The hostname is not in `tenant_domains`, or the tenant is not `active`. In production an
unrecognised hostname is refused rather than defaulting to some dealership — a
misconfiguration should be visible, not silently served.

### "Nobody is getting confirmation emails"

In order:

1. Is the cron running? Nothing sends without it.
2. `SELECT status, last_error FROM email_messages ORDER BY created_at DESC LIMIT 20`
3. `queued` with no error — the worker has not reached it. `failed` — read `last_error`.
   `suppressed` — the tenant has no sender address configured.
4. A message only becomes `delivered` from a provider webhook. Nothing in the
   application can mark it delivered, by design.

### "The assistant is refusing to answer"

Check, in order: is a key configured (`features.ai`), and is the tenant within its
monthly token budget? Both degrade to the contact form deliberately — the customer sees
a service problem rather than a billing one.

### "A customer says they were double-booked"

They were not. `appointment_resources` carries an exclusion constraint, so overlapping
active holds on one resource cannot be committed. Check for a *cancelled* appointment
whose holds were released, or two appointments on different resources.

### "Someone can see another dealership's data"

This should be impossible in three independent ways. If it happens, treat it as an
incident and check:

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user';
```

If either flag is true, the request path is running with a role that ignores RLS. That
is the failure — not the application code.

---

## Reading the system

| Question | Where to look |
|---|---|
| What did the assistant actually do? | `messages` — every tool call, its input and its result |
| Why is this lead high priority? | `leads.score_rationale`, and `lead_signals` for the evidence |
| Who changed this? | `audit_logs`, append-only; the app role has no UPDATE or DELETE |
| Did this booking commit? | `appointments` + `appointment_resources` — a ticket without an appointment cannot exist |
| What is the queue doing? | `job_queue` — `dead` rows are jobs that exhausted their retries |

---

## Before a demo

```bash
npm run db:reset && npm run db:seed    # Sinclair, 10 models, 86 units
npm test                               # 247 assertions
npm run eval                           # the scripted assistant corpus
npm run eval:live                      # needs a key; measures the model itself
```

`eval:live` stops itself at 60 requests, 400k tokens or $2.00. A full run costs roughly
$0.34 with prompt caching — the system prompt and tool definitions are a cacheable
prefix, which is most of the difference.

---

## Known limits

- **The assistant has never spoken to Claude.** No credential has existed in any
  environment it has been built in. Everything around the model is tested; the model's
  own judgement is not.
- **Rate limiting is a fixed window**, not a sliding one. A caller can send two bursts
  across a window boundary. Adequate for abuse, not for precise quota.
- **No MFA.** Recommended for MANAGER and ADMIN before a second dealership goes live.
- **Vehicle imagery is absent.** Every page is built to render without it.
