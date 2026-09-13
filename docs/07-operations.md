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

`AI_PROVIDER` chooses which assistant answers: `scripted`, `anthropic`, or `auto`
(default — the model if a key is present, otherwise scripted). `AI_PROVIDER=scripted`
needs no credential at all; `AI_PROVIDER=anthropic` without one fails at boot with a
message saying so.

Absent, the rule-based assistant answers instead: the same tools and the same live data,
a fixed set of instructions rather than a model. The site is fully usable — customers can
price a build, check stock, book a test drive and reach the team — it is simply plainer,
and it says "I do not have that confirmed" where the model would reason.

Which one answered is on every reply: `mode` is `model`, `scripted`, or `offline` (no
assistant at all — only when a caller passes one explicitly). It is on the JSON response
and on the SSE `done` event. It is deliberately NOT shown to the customer; the assistant
never advertises what is behind it (spec §35).

### 3. The scheduler

Something has to call `/api/cron/worker` every few minutes, authenticated by
`CRON_SECRET`. Which something depends on the host:

| Host | Schedule | Cadence |
|---|---|---|
| GitHub Actions | `.github/workflows/worker.yml` | every 5 minutes, best effort |
| Vercel | `vercel.json` | once a day — the free plan's limit, a backstop only |
| Netlify | `netlify.toml` + `netlify/functions/worker.mts` | every 5 minutes |

The workflow is what actually drives the cadence on a free Vercel project, because
Vercel rejects any cron expression that would run more than once a day on Hobby. It
needs two things set on the repository: a `SITE_URL` variable and a `CRON_SECRET`
secret matching the deployment's.

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

Check `mode` on the reply first.

- `scripted` — no key is configured, or the tenant has spent its monthly token budget.
  The assistant still works; it is answering from rules. Costs nothing, so there is no
  hurry, but the customer is getting the plainer experience.
- `offline` — no assistant at all. Only reachable when a caller passes `client: null`.
- `model` — the model answered, so a refusal to answer is a grounding decision, not a
  configuration one: no tool returned the fact. That is correct behaviour.

A budget that is spent falls back to the scripted assistant rather than to a dead end.
The customer sees a plainer assistant, never a billing problem.

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
| Which assistant answered? | `mode` on the reply: `model`, `scripted` or `offline` |

---

## Before a demo

```bash
npm run db:reset && npm run db:seed    # Sinclair, 10 models, 86 units
npm test                               # 346 assertions
npm run eval                           # scripted — measures the system
npm run eval:rules                     # measures the assistant that ships today
npm run eval:live                      # needs a key; measures the model itself
```

`eval:live` stops itself at 60 requests, 400k tokens or $2.00. A full run costs roughly
$0.34 with prompt caching — the system prompt and tool definitions are a cacheable
prefix, which is most of the difference.

`eval:rules` costs nothing and needs no key. Read its closing note: a green run there
means the assistant said nothing it should not have, not that it chose the tools a model
would choose. The two are different claims and only `eval:live` supports the second.

---

## Known limits

- **The assistant has never spoken to Claude.** No credential has existed in any
  environment it has been built in. Everything around the model is tested; the model's
  own judgement is not. Until a key exists the rule-based assistant answers — the same
  tools and the same data, pattern matching instead of reasoning. It is a demonstrable
  product, not a substitute for measuring the model.
- **The rule-based assistant does not extract.** With no model there is no Pass B, so
  leads carry what the write tools observed (name, email, chosen model, intent) and not
  what a customer implied about budget or timeframe. Priorities are real but thinner.
- **Rate limiting is a fixed window**, not a sliding one. A caller can send two bursts
  across a window boundary. Adequate for abuse, not for precise quota.
- **No MFA.** Recommended for MANAGER and ADMIN before a second dealership goes live.
- **Vehicle imagery is absent.** Every page is built to render without it.
