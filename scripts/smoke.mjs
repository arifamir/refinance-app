#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Drives the entire flow against a running stack: BankID auth -> application
 * -> OCR -> credit/KYC fan-in -> offer -> BankID sign -> disbursement ->
 * schedule -> collection -> ledger check.
 *
 * Requires `pnpm dev` to be running. Exits non-zero on the first failure, so
 * it works as a CI gate as well as a demo driver.
 *
 *   node scripts/smoke.mjs
 */

const BASE = process.env.API_URL ?? "http://localhost:3000";

let token = null;
let step = 0;

const log = (msg) => console.log(`  ${msg}`);
const heading = (msg) => console.log(`\n${++step}. ${msg}`);
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);

function fail(msg) {
  console.error(`  \x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

// Two auth mechanisms, mirroring the app:
//   token      -> Authorization bearer, the authenticated app phase
//   draftToken -> x-draft-token, the anonymous quiz phase
let draftToken = null;

async function call(method, path, body) {
  const sendsBody = method !== "GET" && method !== "DELETE";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(draftToken ? { "x-draft-token": draftToken } : {}),
    },
    ...(sendsBody ? { body: JSON.stringify(body ?? {}) } : {}),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page — surface it verbatim rather than a parse error.
    fail(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!res.ok) fail(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b);
const patch = (p, b) => call("PATCH", p, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kr = (minor) => `${(minor / 100).toLocaleString("sv-SE")} kr`;

/** Poll until `predicate` holds, or give up. */
async function waitFor(label, path, predicate, { tries = 60, delay = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const state = await get(path);
    if (predicate(state)) return state;
    await sleep(delay);
  }
  fail(`timed out waiting for ${label}`);
}

/** BankID orders stay `pending` for a few polls by design. */
async function pollBankId(path, orderRef) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ orderRef }),
    });
    const result = await res.json();
    if (result.status !== "pending") return result;
    await sleep(300);
  }
  fail("BankID order timed out");
}

// ---------------------------------------------------------------------------

console.log(`\n\x1b[1mRefinance smoke test\x1b[0m  ->  ${BASE}`);

const health = await get("/health");
if (!health.ok) fail("API unhealthy");

log("PHASE 1 — anonymous web quiz (no BankID)");

heading("Start an anonymous application");
const created = await post("/applications", { requestedTermMonths: 48 });
const appId = created.id;
draftToken = created.draftToken; // capability token for the whole quiz
if (!draftToken) fail("no draftToken returned");
ok(`anonymous draft ${appId.slice(0, 8)}… (draft token issued, no identity)`);

heading("Add TWO statements (the cart) -> [ocr] workers");
// Consolidation is the product: several expensive debts become one payment.
await post(`/applications/${appId}/statements`, { fileRef: "resurs-bank__statement.jpg" });
await post(`/applications/${appId}/statements`, { fileRef: "klarna__statement.jpg" });

const afterOcr = await waitFor(
  "OCR_DONE",
  `/applications/${appId}/draft`,
  (a) => a.status === "OCR_DONE" || a.status === "REJECTED",
);
if (afterOcr.status !== "OCR_DONE") fail(`OCR ended in ${afterOcr.status}`);
if (afterOcr.statements.length !== 2) {
  fail(`expected 2 statements, found ${afterOcr.statements.length}`);
}
ok(`read ${afterOcr.statements.length} statements from ${afterOcr.existingLender}`);

// The consolidated rate must be the balance-WEIGHTED average, and must sit
// between the two source rates — a plain mean would not be guaranteed to.
const read = afterOcr.statements.filter((s) => s.ocrStatus === "DONE");
const sumBalances = read.reduce((s, r) => s + r.extractedBalanceMinor, 0);
if (sumBalances !== afterOcr.existingBalanceMinor) {
  fail(`balances do not sum: ${sumBalances} vs ${afterOcr.existingBalanceMinor}`);
}
const rates = read.map((r) => r.extractedAprBps);
if (
  afterOcr.existingAprBps < Math.min(...rates) ||
  afterOcr.existingAprBps > Math.max(...rates)
) {
  fail(`weighted rate ${afterOcr.existingAprBps} outside [${Math.min(...rates)}, ${Math.max(...rates)}]`);
}
ok(
  `consolidated ${kr(afterOcr.existingBalanceMinor)} at a weighted ${
    afterOcr.existingAprBps / 100
  }% (sources: ${rates.map((r) => r / 100 + "%").join(", ")})`,
);

heading("KALP affordability questionnaire");
await patch(`/applications/${appId}/kalp`, {
  ownsAccommodation: false,
  hasSpouse: false,
  numberOfChildren: 0,
  monthlyIncomeGrossMinor: 4_500_000, // 45 000 kr/month
  incomeSource: "PERMANENT_EMPLOYMENT",
  monthlyDebtPaymentMinor: 400_000, // 4 000 kr/month
});
await patch(`/applications/${appId}/contact`, {
  email: "test.testsson@example.com",
  phone: "+46701234567",
});
ok("answers saved atomically");

heading("Capture the lead (quiz ends — still no identity)");
const lead = await post(`/applications/${appId}/lead`);
if (lead.status !== "LEAD" || !lead.claimToken) fail(`lead not captured: ${JSON.stringify(lead)}`);
const claimToken = lead.claimToken; // the magic-link stand-in
// Prove the quiz can no longer reach an assessment without identity.
draftToken = null;
const preAuth = await fetch(`${BASE}/applications/${appId}/submit`, { method: "POST" });
if (preAuth.status !== 401) fail(`anonymous submit should be 401, got ${preAuth.status}`);
ok("lead captured; submit is refused without BankID (401)");

log("");
log("PHASE 2 — authenticated app (BankID)");

heading("BankID identity + claim the lead");
const authStart = await post("/auth/bankid/start", {});
const authResult = await pollBankId("/auth/bankid/collect", authStart.orderRef);
if (authResult.status !== "complete") fail(`auth ${authResult.status}`);
token = authResult.token;
ok(`verified as ${authResult.customer.displayName} (${authResult.personalNumber})`);

const claimed = await post("/applications/claim", { claimToken });
if (claimed.id !== appId) fail(`claim returned a different application: ${claimed.id}`);
// The one-time token must not be replayable.
const replay = await fetch(`${BASE}/applications/claim`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ claimToken }),
});
if (replay.status !== 404) fail(`claim replay should be 404, got ${replay.status}`);
ok("lead claimed by the verified customer; replay refused (404)");

heading("Submit -> [credit-check] + [kyc-aml] -> [decision] (flow fan-in)");
await post(`/applications/${appId}/submit`);
const decided = await waitFor(
  "a decision",
  `/applications/${appId}`,
  (a) => ["OFFERED", "REJECTED"].includes(a.status),
  { tries: 90 },
);
if (decided.status !== "OFFERED") {
  fail(`application ${decided.status}: ${decided.creditDecision?.reason ?? "unknown"}`);
}
ok(`UC score ${decided.creditDecision.bureauScore} (${decided.creditDecision.riskBand}), KYC ${decided.kycCheck.status}`);

// Affordability must have been assessed, and at a STRESSED rate — approving on
// the headline rate is the mistake the whole KALP requirement exists to prevent.
const cd = decided.creditDecision;
if (cd.kalpMinor === null) fail("no KALP assessment was recorded");
if (cd.stressedAprBps <= decided.offer.offeredAprBps) {
  fail(`stressed rate ${cd.stressedAprBps} is not above the offered ${decided.offer.offeredAprBps}`);
}
ok(
  `KALP ${kr(cd.kalpMinor)}/month left over, stress-tested at ${cd.stressedAprBps / 100}% (offered ${
    decided.offer.offeredAprBps / 100
  }%)`,
);

const offer = decided.offer;
ok(
  `offered ${offer.offeredAprBps / 100}% over ${offer.termMonths}m — ${kr(
    offer.monthlyPaymentMinor,
  )}/month, saves ${kr(offer.savingMinor)}`,
);
if (offer.offeredAprBps >= decided.existingAprBps) {
  fail("offered rate is not better than the existing rate");
}

heading("Sign the credit agreement with BankID");
const signStart = await post(`/offers/${offer.id}/sign/start`, {});
log(`terms shown on phone: ${signStart.termsShownToUser.replace(/\n/g, " | ")}`);
const signResult = await pollBankId(`/offers/${offer.id}/sign/collect`, signStart.orderRef);
if (signResult.status !== "complete") fail(`signing ${signResult.status}`);
const loanId = signResult.loanId;
ok(`signed — loan ${loanId.slice(0, 8)}… created`);

heading("[disbursement] worker (fails once on purpose, then retries)");
const active = await waitFor(
  "loan ACTIVE",
  `/loans/${loanId}`,
  (l) => l.status === "ACTIVE",
  { tries: 90, delay: 700 },
);
ok(`disbursed to ${active.disbursements[0].beneficiary} after ${active.disbursements[0].attempts} attempt(s)`);
if (active.disbursements.length !== 1) {
  fail(`expected exactly 1 disbursement, found ${active.disbursements.length} — DOUBLE PAY`);
}
ok(`exactly 1 disbursement row — no double payment`);
ok(`schedule generated: ${active.schedule.length} installments`);

// The invariant that matters: the schedule must repay the principal exactly.
const principalSum = active.schedule.reduce((s, r) => s + r.principalPartMinor, 0);
if (principalSum !== active.principalMinor) {
  fail(`schedule repays ${principalSum}, principal is ${active.principalMinor}`);
}
ok(`schedule repays principal exactly (${kr(principalSum)})`);
if (active.schedule.at(-1).balanceAfterMinor !== 0) fail("final balance is not zero");
ok("final installment clears the balance to 0");

heading("[collection] sweep");
// A correct sweep finds nothing on a fresh loan — the first installment is due
// in a month. Move the clock rather than weaken the scheduling logic.
const beforePaid = active.paidInstallments;
const advanced = await post(`/ops/loans/${loanId}/advance?months=1`);
log(`advanced ${advanced.installmentsShifted} due dates by 1 month`);
await post("/ops/run-collection");
const collected = await waitFor(
  "an installment to be collected",
  `/loans/${loanId}`,
  (l) => l.paidInstallments > beforePaid,
  { tries: 60, delay: 700 },
);
ok(`collected ${collected.paidInstallments} installment(s), ${kr(collected.outstandingPrincipalMinor)} outstanding`);

heading("Ledger integrity");
const ledger = await get(`/loans/${loanId}/ledger`);
if (!ledger.totals.balanced) {
  fail(`ledger unbalanced: debits ${ledger.totals.debits} credits ${ledger.totals.credits}`);
}
ok(`${ledger.entries.length} entries, debits == credits (${kr(ledger.totals.debits)})`);

const books = await get("/ops/books");
if (!books.balanced) fail("whole-book check failed");
ok(`whole book balanced across ${books.loans} loan(s), ${books.ledgerEntries} entries`);

console.log(`\n\x1b[32m\x1b[1mAll checks passed.\x1b[0m\n`);
