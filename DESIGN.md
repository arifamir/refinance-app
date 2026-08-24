# Design notes

A learning-oriented reference implementation of a **consumer-loan refinancing**
product: photograph an existing loan/credit-card statement, get assessed, and —
if approved — have the old lender paid off and repay the new loan monthly.

The point of the repo is the *engineering shape* of that problem, not the
product. Everything below is the reasoning behind the code.

---

## 1. What loan refinancing is

Replacing an existing loan with a new one on better terms. A new lender pays off
the old debt; the borrower now repays the new lender, typically at a lower rate,
a different term, or by consolidating several debts into one monthly payment.

The interesting truth for engineering: almost every step — OCR, credit check,
KYC, paying off the old lender, collecting monthly — is **slow, external,
unreliable, and touches money**. Those steps must be safe to retry, impossible
to double-charge, and auditable. That single observation drives the whole
architecture.

---

## 2. Core domain model

```
Customer ──1:N── LoanApplication ──1:1── Offer
                      │                     │
                      │                     └── (accepted) ──> Loan
                      │
                      └── StatementUpload[] (OCR results — the "cart")

Loan ──1:N── Disbursement        (pay off the old creditor)
Loan ──1:N── RepaymentSchedule   (amortization plan)
Loan ──1:N── Payment             (incoming collections)
Loan ──1:N── LedgerEntry         (double-entry money movements)
```

An application can carry several statements — consolidating multiple expensive
debts into one loan is a first-class case.

---

## 3. Money-handling rules

1. **Money is never a float.** Everything is an integer count of **minor units**
   (öre/cents) plus an explicit currency. `0.1 + 0.2 !== 0.3` in IEEE-754, and
   on a ledger that error compounds.
2. **Rates are integer basis points** (990 = 9.9%), for the same reason.
3. **Double-entry ledger.** Every movement is balanced debits/credits. The loan
   balance is a **projection** over the ledger, never a mutable counter — a
   counter drifts; a projection cannot disagree with the entries it derives
   from. It also *is* the audit trail regulators require.
4. **Idempotency keys** on every external money call. A retried job with the
   same key is a no-op, not a second payment.
5. **State machine, not booleans.** An application/loan is always in exactly one
   known state; transitions are explicit and logged, and illegal ones throw.

---

## 4. The two-phase flow

The product is split into an **anonymous web quiz** and a separate
**authenticated app**, because identity is the highest-friction step and should
come *last* — you don't need a verified identity to *collect* self-reported
data, only to *act on* it.

```
── PHASE 1 · anonymous web quiz (no identity) ───────────────
pick lender → upload statement(s) → [ocr] → KALP questions → contact
                                                → LEAD (captured) + claim token
── PHASE 2 · authenticated app (BankID) ─────────────────────
BankID auth → claim the lead → submit → [credit-check] ┐
                                        [kyc-aml]       ├→ [decision] → OFFER
                                                        ┘  (flow fan-in)
OFFER → BankID sign → ACCEPTED → [disbursement] → loan ACTIVE + schedule
                                        [collection] (repeatable) → CLOSED
                                        [interest-accrual] (repeatable)
```

- The quiz is authorised by a per-application **capability token**
  (`x-draft-token`), not a session — there is no customer yet.
- `LEAD` is a real state. Finishing the quiz mints a one-time **claim token**
  (a stand-in for a magic-link email); the app presents it after BankID to bind
  the lead to the verified customer. Replay is refused.
- The credit bureau is touched only in phase 2, after identity is verified.

`[bracketed]` steps are BullMQ jobs in a separate worker process.

---

## 5. Why a queue (BullMQ)

A queue is for work that must still happen **after the user closes the app and
after the server restarts.**

- **Durable obligations.** Once an offer is signed we owe the disbursement; a
  crash cannot lose it.
- **Scheduled work.** Interest accrual and monthly collection have no request to
  hang off, and naive cron across N instances would run them N times. Repeatable
  jobs give a distributed lock for free.
- **Retries + rate limits.** Payment rails fail; bureaus charge per query and cap
  QPS. Backoff, dead-lettering and a global limiter are the queue's job.

What deliberately does **not** go in a queue: BankID auth/sign. It's
user-in-the-loop and short-TTL, so a retry means a new order and fresh consent —
it belongs in the request path.

### The transactional outbox

Enqueue-after-commit is not atomic: a crash between the DB commit and the Redis
enqueue loses the job. So the disbursement is enqueued through an **outbox** — a
row written in the *same transaction* as the loan, relayed to BullMQ with
`FOR UPDATE SKIP LOCKED`. Postgres stays the single source of truth; Redis is
just delivery. (`packages/db/src/outbox.ts`, `apps/worker/src/relay.ts`.)

---

## 6. Idempotency — the money shot

Disbursement (`apps/worker/src/processors/disbursement.ts`) has three guards
against double-paying:

1. Deterministic `jobId` → BullMQ dedupes enqueues.
2. **Unique constraint on `Disbursement.idempotencyKey`** → even two workers
   racing can't both insert. *This is the one that survives a restart.*
3. Idempotency key sent to the payment provider → the rail replays the original
   result.

The credit check is the sharper case: a duplicate hard inquiry is an
**irreversible** harm (a footprint on the customer's record), so the processor
is check-then-call, guarded by a unique constraint on `applicationId`. A soft
score check (`/uc-score`) leaves no footprint and can be called freely — the
same `CreditBureau.fetchConsumerReport` with `soft: true`.

---

## 7. KALP — affordability

**KALP** ("Kvar Att Leva På" — what's left to live on) is the Swedish statutory
affordability standard (`packages/domain/src/kalp.ts`):

```
KALP = net income
     − standardised living costs (household composition)
     − housing costs
     − existing debt service
     − the new loan's payment, STRESS-TESTED above the offered rate
```

Two properties worth knowing:

- **Assessed at a stressed rate**, never the headline one (offered + 300bps,
  floored at 8%). Approving on the advertised rate is the mistake the rule exists
  to prevent.
- **Debt being refinanced away is not double-counted** — consolidating replaces
  the old payments.

A clean credit history does not override it. The reference cost figures are
illustrative; a production system would load the official yearly table and
version it so a historic decision re-derives exactly.

---

## 8. Tech choices

| Concern | Pick | Why |
|---|---|---|
| Web framework | Hono | TS-first, Web-Standard Request/Response, testable in-process via `app.request()` |
| Validation | zod + `@hono/zod-validator` | one schema → types + runtime validation, shared |
| DB access | Prisma | typed queries; the unique constraints ARE the idempotency guarantees |
| Queue | BullMQ + Redis | retries, rate limit, repeatable, flows (fan-in) |
| Money | integer minor units + `Int` columns | no float error |
| Client state | Zustand (sessionStorage) | wizard draft; sessionStorage because the answers are PII |
| Testing | vitest + a real Postgres/Redis integration layer | unit for logic, integration for the schema-backed guarantees |

---

## 9. Security & PII

- Personal numbers are hashed for lookup and AES-256-GCM encrypted for the one
  authorised read the credit check needs — never stored in the clear.
- Every authenticated read is scoped by `customerId` (no IDOR).
- The anonymous quiz uses an unguessable capability token, so a leaked
  application id alone cannot mutate a draft.
- BankID produces the only trusted personal number; nothing downstream trusts a
  client-supplied one.
- `/ops/*` is guarded by a shared secret (`OPS_TOKEN`); open only in demo mode.

---

## 10. Deliberate limits

- External services are **fakes behind ports** (`IdentityProvider`,
  `CreditBureau`, `StatementOcr`, `PaymentProvider`). Real adapters drop in
  behind the same interface.
- The client **polls**; production would use SSE/WebSockets.
- Schedules are compressed (collection ~30s, accrual ~60s) so a demo shows
  something; real values are monthly and daily.
- `FakePaymentProvider` keeps idempotency state in memory; the DB unique
  constraint is the durable guard.
