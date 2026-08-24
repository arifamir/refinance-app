/**
 * Disbursement idempotency — against a real database.
 *
 * The unit test in payments.test.ts proves the fake provider replays. This
 * proves the guarantee that actually matters in production: even if the SAME
 * job runs twice (at-least-once delivery, or two workers racing), the DATABASE
 * refuses a second payment and the ledger stays balanced. That guard survives
 * a process restart; the in-memory one does not.
 */

import { describe, expect, it } from "vitest";
import { disbursementIdempotencyKey } from "@refi/domain";
import { processDisbursement } from "../../apps/worker/src/processors/disbursement.js";
import { prisma } from "./db.js";
import { fakeJob, makeApplication } from "./factory.js";

/** Seed an application all the way to a signed offer with a DISBURSING loan. */
async function makeSignedLoan(principalMinor = 4_500_000) {
  const app = await makeApplication({
    status: "ACCEPTED",
    existingBalanceMinor: principalMinor,
    existingAprBps: 2_495,
    existingLender: "Resurs Bank",
  });

  const offer = await prisma.offer.create({
    data: {
      applicationId: app.id,
      principalMinor,
      offeredAprBps: 990,
      termMonths: 48,
      monthlyPaymentMinor: 113_916,
      savingMinor: 1_000_000,
      status: "ACCEPTED",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  const loan = await prisma.loan.create({
    data: {
      offerId: offer.id,
      principalMinor,
      aprBps: 990,
      termMonths: 48,
      status: "DISBURSING",
      correlationId: app.correlationId,
    },
  });

  return { app, loan };
}

function disbursementJob(loanId: string, correlationId: string, attemptsMade = 0) {
  return fakeJob(
    {
      loanId,
      idempotencyKey: disbursementIdempotencyKey(loanId),
      correlationId,
    },
    attemptsMade,
  );
}

describe("disbursement", () => {
  it("pays the old lender exactly once even when the job runs twice", async () => {
    const { app, loan } = await makeSignedLoan();
    const job = disbursementJob(loan.id, app.correlationId);

    await processDisbursement(job);
    await processDisbursement(job); // at-least-once replay

    const disbursements = await prisma.disbursement.findMany({ where: { loanId: loan.id } });
    expect(disbursements).toHaveLength(1);
    expect(disbursements[0]!.status).toBe("SETTLED");

    // The ledger must show one disbursement posting, not two.
    const receivable = await prisma.ledgerEntry.findMany({
      where: { loanId: loan.id, account: "loan_receivable", direction: "DEBIT" },
    });
    expect(receivable).toHaveLength(1);
    expect(receivable[0]!.amountMinor).toBe(loan.principalMinor);
  });

  it("moves the loan to ACTIVE and generates a full schedule", async () => {
    const { app, loan } = await makeSignedLoan();
    await processDisbursement(disbursementJob(loan.id, app.correlationId));

    const active = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(active.status).toBe("ACTIVE");
    expect(active.disbursedAt).not.toBeNull();

    const schedule = await prisma.repaymentSchedule.findMany({ where: { loanId: loan.id } });
    expect(schedule).toHaveLength(48);

    // The end-to-end money invariant: the schedule repays principal exactly.
    const repaid = schedule.reduce((s, r) => s + r.principalPartMinor, 0);
    expect(repaid).toBe(loan.principalMinor);
  });

  it("does not double-generate the schedule on a replay", async () => {
    const { app, loan } = await makeSignedLoan();
    const job = disbursementJob(loan.id, app.correlationId);

    await processDisbursement(job);
    await processDisbursement(job);

    const schedule = await prisma.repaymentSchedule.count({ where: { loanId: loan.id } });
    expect(schedule).toBe(48);
  });

  it("keeps the books balanced after disbursement", async () => {
    const { app, loan } = await makeSignedLoan();
    await processDisbursement(disbursementJob(loan.id, app.correlationId));

    const entries = await prisma.ledgerEntry.findMany({ where: { loanId: loan.id } });
    const debits = entries.filter((e) => e.direction === "DEBIT").reduce((s, e) => s + e.amountMinor, 0);
    const credits = entries.filter((e) => e.direction === "CREDIT").reduce((s, e) => s + e.amountMinor, 0);
    expect(debits).toBe(credits);
  });
});
