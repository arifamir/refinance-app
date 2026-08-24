/**
 * Daily interest accrual.
 *
 * Interest is earned continuously but collected monthly. Accrual recognises
 * what we've earned each day so the books reflect reality between payments —
 * an accounting requirement, not an optional nicety.
 *
 * Purely scheduled work: there is no HTTP request to hang this off, which is
 * the second half of the "why a queue" argument — durability and scheduling.
 */

import type { Job } from "bullmq";
import { accrualPosting, dailyRate, type InterestAccrualJob } from "@refi/domain";
import { outstandingPrincipalMinor, postLedger, prisma } from "@refi/db";
import { log } from "../connection.js";

export async function processInterestAccrual(job: Job<InterestAccrualJob>): Promise<void> {
  const { correlationId } = job.data;

  const loans = await prisma.loan.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, aprBps: true },
  });

  if (loans.length === 0) {
    log("interest-accrual", correlationId, "no active loans");
    return;
  }

  let totalAccrued = 0;

  for (const loan of loans) {
    // Balance projected from the ledger, not read from a column.
    const balance = await outstandingPrincipalMinor(loan.id);
    if (balance <= 0) continue;

    const interestMinor = Math.round(balance * dailyRate(loan.aprBps));
    // Sub-öre accrual on a tiny balance rounds to zero — skip rather than
    // posting a meaningless empty entry.
    if (interestMinor <= 0) continue;

    await postLedger({
      loanId: loan.id,
      lines: accrualPosting(interestMinor),
      correlationId,
      memo: `Daily interest accrual on ${balance / 100} kr`,
    });

    totalAccrued += interestMinor;
  }

  log(
    "interest-accrual",
    correlationId,
    `accrued ${totalAccrued / 100} kr across ${loans.length} loan(s)`,
  );
}
