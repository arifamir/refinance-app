# Refinance — a consumer-loan refinancing reference implementation

A working, end-to-end vertical slice of a consumer-loan refinancing product,
built as a learning project: how to model money, queues, idempotency and
regulated affordability correctly. Design rationale lives in
**[DESIGN.md](DESIGN.md)**; this file is how to run it.

**Stack:** TypeScript · Hono · BullMQ · PostgreSQL · Prisma · React · Vite · Zustand

---

## The flow

**Two phases**, one decision per screen, several statements consolidated into a
single loan.

```
── PHASE 1 · anonymous web quiz (NO BankID) ──────────────────────────
pick lender ─> upload statement ──┐
      ▲                           ├─> [ocr] per statement
      └──── "add more loans" ─────┘         │  all read
            (the cart)                      ▼
                          KALP questions ─> contact ─> LEAD (captured)
                                                          │  claim token
── PHASE 2 · authenticated app (BankID) ──────────────────┼───────────
                          BankID auth ─> claim the lead ─> submit
                                                          ▼
                                              [credit-check] ┐
                                              [kyc-aml]      ├─> [decision] ─> OFFER
                                                             ┘   (flow fan-in)
OFFER ─> BankID sign ─> ACCEPTED ─> [disbursement] ─> loan ACTIVE + schedule
                                                          │
                                   [collection] (repeatable) ─> installments PAID ─> CLOSED
                                   [interest-accrual] (repeatable)
```

`[bracketed]` steps are BullMQ jobs running in a separate worker process.

### Why the flow is split (and BankID comes last)

There is no BankID on the website — the whole quiz is **anonymous**. Identity is
the highest-friction step, so it comes last, once the customer is invested;
authenticating first would tank conversion. And you don't need a verified
identity to *collect* self-reported data, only to *act on* it (the credit pull,
the signature).

So the model is two phases:

- **Anonymous quiz** — `customerId` is null; the draft is authorised by a
  per-application **capability token** (`x-draft-token`), not a session. Ends by
  capturing a `LEAD` and minting a one-time **claim token** (the stand-in for the
  magic link that would be emailed).
- **Authenticated app** — BankID verifies identity, `POST /applications/claim`
  binds the lead to the customer (one-time; replay is refused), and only then is
  the credit bureau touched.

### KALP — the part that makes this a *lending* app

**KALP** ("Kvar Att Leva På" — what's left to live on) is the Swedish statutory
affordability assessment. A lender must establish that the borrower can service
the loan *after* normal living costs, using standardised reference values rather
than whatever the applicant claims they spend:

```
KALP = net income
     − standardised living costs (household composition)
     − housing costs
     − existing debt service
     − the new loan's payment, STRESS-TESTED above the offered rate
```

Two properties worth knowing about the implementation in
[packages/domain/src/kalp.ts](packages/domain/src/kalp.ts):

- **It is assessed at a stressed rate**, never the headline one — offered + 300bps,
  floored at 8%. Approving on the rate you advertise is the mistake the rule exists
  to prevent.
- **Debt being refinanced away is not double-counted.** Consolidating three loans
  replaces their payments; counting both the old and the new would wrongly decline
  exactly the customers the product is for.

A clean credit history does not override it. If the numbers say unaffordable, the
application is declined — that is the outcome the requirement is designed to produce.

---

## Run it

### Prerequisites

- **Node 20+** (verified on 24.18.0). Install via [nvm](https://github.com/nvm-sh/nvm):
  `nvm install --lts`.
- **pnpm** — enable it with Corepack (bundled with Node): `corepack enable`,
  or `npm install -g pnpm`.
- **Docker Desktop**, running — used only for Postgres + Redis. Confirm the
  daemon is up with `docker info`.
- Free local ports: **3000** (API), **5173** (web), **5432** (Postgres),
  **6379** (Redis).

### Start

```bash
cp .env.example .env

# One-shot: install + start infra + generate client + create schema
pnpm setup

pnpm dev               # api :3000 + worker + web :5173
```

`pnpm setup` bundles the four steps below; run them individually if you prefer:

```bash
pnpm install
pnpm infra:up          # postgres + redis, healthchecked docker containers
pnpm db:generate       # prisma client
pnpm db:push           # create the schema
```

Then open **http://localhost:5173** and click through the flow.

Watch the **worker terminal** while you do — that is where the architecture is
actually visible: jobs picked up, a disbursement failing and retrying, the
collection sweep firing on its schedule.

```bash
pnpm test              # 63 unit tests, no infra needed, ~3s
pnpm test:integration  # 34 integration tests — needs infra up (pnpm infra:up)
pnpm typecheck
pnpm smoke             # end-to-end check — needs `pnpm dev` running
pnpm infra:reset       # wipe postgres + redis volumes and start clean
```

> **First `pnpm install` can take several minutes** on a cold cache (it also
> downloads the Prisma engine and esbuild binaries). Run it before you need the
> app, not while someone's watching.

**Tests come in two layers, on purpose.** Unit tests cover logic that must never
be wrong — amortization invariants, KALP, the state machine, ledger balancing.
Integration tests cover the guarantees that only exist because of a database
constraint: disbursement pays once under replay, the credit check skips a second
UC pull, the flow fan-in waits for both children, IDOR is refused, and the outbox
never dispatches a rolled-back job. A rule is only as good as the schema behind
it, so the integration layer exercises the schema.

`pnpm smoke` drives the entire flow headlessly and asserts the invariants that
matter — exactly one disbursement row, the schedule repaying principal to the
öre, and debits == credits:

```
1. BankID authentication            ✓ authenticated as Test Testsson
2. Create application               ✓ application 4377673e… in DRAFT
3. Upload statement -> [ocr]        ✓ read Resurs Bank: 69 737 kr @ 23.85%
4. Submit -> credit + kyc -> decide ✓ offered 14.9% — saves 15 862,69 kr
5. Sign with BankID                 ✓ signed — loan 3b845e11… created
6. [disbursement]                   ✓ disbursed after 2 attempt(s)
                                    ✓ exactly 1 disbursement row — no double payment
                                    ✓ schedule repays principal exactly
7. [collection] sweep               ✓ collected 1 installment(s)
8. Ledger integrity                 ✓ 9 entries, debits == credits
```

### If `pnpm install` blocks build scripts

pnpm 11 requires approval for postinstall scripts. This repo pre-approves the
five that genuinely need them (Prisma engines, esbuild) in
[pnpm-workspace.yaml](pnpm-workspace.yaml) under `allowBuilds`. If your pnpm
still prompts, run `pnpm approve-builds`.

---

## What to look at

| Concern | File |
|---|---|
| **KALP affordability engine** (20 tests) | [packages/domain/src/kalp.ts](packages/domain/src/kalp.ts) |
| Amortisation maths (pure, well-tested) | [packages/domain/src/amortization.ts](packages/domain/src/amortization.ts) |
| Money as integer minor units | [packages/domain/src/money.ts](packages/domain/src/money.ts) |
| Balance-weighted consolidation of several statements | [packages/db/src/consolidate.ts](packages/db/src/consolidate.ts) |
| Wizard state (Zustand, **sessionStorage** — see below) | [apps/web/src/store.ts](apps/web/src/store.ts) |
| State machines | [packages/domain/src/states.ts](packages/domain/src/states.ts) |
| Double-entry ledger rules | [packages/domain/src/ledger.ts](packages/domain/src/ledger.ts) |
| **Idempotent credit check** | [apps/worker/src/processors/creditCheck.ts](apps/worker/src/processors/creditCheck.ts) |
| **Idempotent disbursement** | [apps/worker/src/processors/disbursement.ts](apps/worker/src/processors/disbursement.ts) |
| **Transactional outbox** (write) + relay | [packages/db/src/outbox.ts](packages/db/src/outbox.ts), [apps/worker/src/relay.ts](apps/worker/src/relay.ts) |
| Flow fan-in (credit + KYC → decision) | [apps/worker/src/processors/decision.ts](apps/worker/src/processors/decision.ts) |
| Queue config, limiters, repeatables | [apps/worker/src/index.ts](apps/worker/src/index.ts) |
| BankID auth & sign | [apps/api/src/routes/auth.ts](apps/api/src/routes/auth.ts), [offers.ts](apps/api/src/routes/offers.ts) |
| Soft credit-score check (no footprint) | [apps/api/src/routes/ucScore.ts](apps/api/src/routes/ucScore.ts), [apps/web/src/UcChecker.tsx](apps/web/src/UcChecker.tsx) |
| Ports + fakes | [packages/adapters/src/](packages/adapters/src/) |

---

## Driving the demo

Everything external is faked **deterministically**, so you can force any path
on demand instead of re-rolling until you get the outcome you wanted to show.

### Credit outcomes — by the last digit of the personal number

The fake BankID always authenticates as `199001019876` (ends in **6** → approved).
Change `FAKE_BANKID_COLLECTS_UNTIL_COMPLETE` or edit `FakeIdentityProvider`'s
`personalNumber` to try others:

| Last digit | Outcome |
|---|---|
| `0` | Payment remarks → **REJECTED**, and KYC lands in `MANUAL_REVIEW` |
| `1` | High risk → **REJECTED** on affordability |
| `9` | Low risk → approved at the **best rate** (6.9%) |
| other | Deterministic spread across the middle bands |

### OCR outcomes — by the `fileRef` you type

| fileRef contains | Outcome |
|---|---|
| `lowconf` | Confidence 0.4 → application **REJECTED** as unreadable |
| `fail` | Throws → watch **BullMQ retry** with exponential backoff |
| anything else | Deterministic lender, balance (15–95k kr) and rate (18–29.95%) |

### Prove the idempotency claim

`FAKE_PAYMENT_TRANSIENT_FAILURES=1` (the default) makes the payment rail fail
the first disbursement attempt. Sign an offer and watch the worker log:

```
[disbursement] paying 45000 kr to Nordax Bank (attempt 1)
[disbursement] job ... failed (1/5), will retry: Simulated payout failure 1/1
[disbursement] paying 45000 kr to Nordax Bank (attempt 2)
[disbursement] settled fake-payout-... — loan ACTIVE
```

The old lender was paid **once**. Three independent guards make that true —
deterministic `jobId`, a unique constraint on `Disbursement.idempotencyKey`,
and the idempotency key sent to the provider. Only the middle one survives a
restart, which is why it exists.

---

## Ops endpoints

```bash
curl localhost:3000/ops/queues                 # depths per queue
curl localhost:3000/ops/queues/ocr/failed      # dead letters
curl localhost:3000/ops/books                  # do total debits == total credits?
curl -X POST localhost:3000/ops/run-collection # trigger a sweep now
curl -X POST "localhost:3000/ops/loans/<id>/advance?months=1"   # simulate a month passing
```

`/ops/books` is the one-line integrity answer: the whole ledger must balance.

**On `/advance`:** a freshly disbursed loan has its first installment due in a
month, so a *correct* collection sweep finds nothing to do. Rather than weaken
the scheduling logic to make the demo look busy, this shifts the due dates
backwards and lets the sweep pick them up through the normal path. The
collection processor knows nothing about it.

---

## Deployment shape

Local dev runs Node on the host against containerised infra (Postgres + Redis).
For CI/prod the [Dockerfile](Dockerfile) is multi-stage and builds
**two images from one base** — `api` and `worker` — because they scale
independently: an OCR burst needs more workers, not more API replicas, and the
money-moving worker should never share a process with request handling.

```bash
docker build --target api    -t refinance-api    .
docker build --target worker -t refinance-worker .
```

Migrations run out-of-band (a release job runs `prisma migrate deploy`), never on
container start, so a scaled-up replica never races another on schema.

---

## Deliberate scope limits

Called out rather than left to be discovered:

- **Fakes, not vendors.** UC needs a signed agreement and a demonstrated
  "legitimate need"; BankID needs certs and the test app. Both sit behind ports
  (`IdentityProvider`, `CreditBureau`) — swap the adapter, keep everything else.
- **The client polls.** Production would use SSE or WebSockets. Polling keeps
  the demo dependency-free and is the honest consequence of an async backend.
- **`/ops/*` is unauthenticated.** In production it lives behind an internal
  network boundary and staff auth.
- **Schedules are compressed.** Collection runs every 30s and accrual every 60s
  so a demo shows something; the real values are monthly and daily.
- **`FakePaymentProvider` keeps idempotency state in memory**, so a worker
  restart forgets it. The database unique constraint is the durable guard —
  which is precisely the point being made.
- **`/ops/*` is open in demo mode.** With no `OPS_TOKEN` set the staff guard is
  disabled so the demo works; set a secret in any shared environment and requests
  need an `x-ops-token` header. A real deployment always sets it (fail-closed).
- **Konsumentverket figures are illustrative.** The KALP reference costs are the
  right shape and order of magnitude, but a production system would load the
  current official table per year and version it, so a historic decision can be
  re-derived exactly rather than recalculated with today's numbers.

## Why the wizard draft lives in sessionStorage

The apply flow keeps its answers in a Zustand store persisted to
**`sessionStorage`, deliberately not `localStorage`**.

Those answers are financial PII — income, household composition, number of
children, contact details. `localStorage` would leave them on the device
indefinitely, readable by any XSS and still present on a shared computer days
later. `sessionStorage` scopes them to the tab, and `reset()` purges them the
moment the server has the data.

It also pairs with the API: the client holds a **draft**, the server receives one
**atomic** payload. A half-written affordability assessment is worse than none,
because it looks like an assessment.
