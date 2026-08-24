/**
 * Disbursement — paying off the customer's old lender.
 *
 * The single most dangerous job in the system, and the clearest justification
 * for the whole queue architecture:
 *
 *   * It MUST eventually happen. Once the agreement is signed we owe this
 *     payment; a crash cannot be allowed to lose it. Hence: durable queue,
 *     5 attempts, exponential backoff.
 *   * It must happen EXACTLY ONCE. At-least-once delivery means retries are
 *     guaranteed, so the code has to make duplicates impossible.
 *
 * Three layers of defence against double-paying:
 *   1. Deterministic jobId (`disburse:<loanId>`) — BullMQ dedupes enqueues.
 *   2. Unique constraint on Disbursement.idempotencyKey — the database
 *      refuses a second row even under a concurrent race.
 *   3. Idempotency key sent to the payment provider — the rail itself
 *      replays the original result instead of moving money again.
 *
 * Layer 2 is the one that actually saves you, because it survives a restart.
 */

import type { Job } from "bullmq";
import { Queue } from "bullmq";
import {
  BEST_EFFORT_JOB_OPTS,
  QUEUE,
  addMonths,
  buildSchedule,
  disbursementPosting,
  type DisbursementJob,
} from "@refi/domain";
import { getAdapters } from "@refi/adapters";
import { postLedger, prisma, transitionLoan } from "@refi/db";
import { connection, log } from "../connection.js";

const notifications = new Queue(QUEUE.notifications, { connection });

export async function processDisbursement(job: Job<DisbursementJob>): Promise<void> {
  const { loanId, idempotencyKey, correlationId } = job.data;

  const loan = await prisma.loan.findUniqueOrThrow({
    where: { id: loanId },
    include: { offer: { include: { application: { include: { customer: true } } } } },
  });

  // Already settled — a retry arriving after success. Nothing to do.
  const existing = await prisma.disbursement.findUnique({ where: { idempotencyKey } });
  if (existing?.status === "SETTLED") {
    log("disbursement", correlationId, "already settled — no-op");
    await ensureActive(loanId, correlationId);
    return;
  }

  const beneficiary = loan.offer.application.existingLender ?? "Unknown lender";

  // Claim the attempt. The unique constraint means only one worker can hold
  // this row, even if two process the same job concurrently.
  const disbursement =
    existing ??
    (await prisma.disbursement.create({
      data: {
        loanId,
        idempotencyKey,
        amountMinor: loan.principalMinor,
        beneficiary,
        status: "PENDING",
      },
    }));

  await prisma.disbursement.update({
    where: { id: disbursement.id },
    data: { attempts: { increment: 1 } },
  });

  const { payments } = getAdapters();
  log(
    "disbursement",
    correlationId,
    `paying ${loan.principalMinor / 100} kr to ${beneficiary} (attempt ${job.attemptsMade + 1})`,
  );

  let result;
  try {
    result = await payments.payout({
      idempotencyKey, // same key on every retry — this is the contract
      amountMinor: loan.principalMinor,
      currency: loan.currency,
      beneficiary,
    });
  } catch (error) {
    await prisma.disbursement.update({
      where: { id: disbursement.id },
      data: { lastError: (error as Error).message },
    });
    // Rethrow so BullMQ retries with backoff. The Disbursement row survives,
    // so the next attempt reuses the same key rather than starting fresh.
    throw error;
  }

  if (result.replayed) {
    log("disbursement", correlationId, "provider replayed — money moved only once");
  }

  // --- Money has moved. Record it, build the schedule, go ACTIVE. ---------
  await prisma.$transaction(async (tx) => {
    await tx.disbursement.update({
      where: { id: disbursement.id },
      data: {
        status: "SETTLED",
        providerRef: result.providerRef,
        settledAt: new Date(),
        lastError: null,
      },
    });

    // First installment falls one month after disbursement.
    const firstDueDate = addMonths(startOfDayUtc(new Date()), 1);
    const schedule = buildSchedule({
      principalMinor: loan.principalMinor,
      aprBps: loan.aprBps,
      termMonths: loan.termMonths,
      firstDueDate,
    });

    // createMany + the [loanId, installmentNo] unique constraint: a retry that
    // somehow reaches here cannot duplicate the schedule.
    await tx.repaymentSchedule.createMany({
      data: schedule.map((row) => ({
        loanId,
        installmentNo: row.installmentNo,
        dueDate: row.dueDate,
        principalPartMinor: row.principalPartMinor,
        interestPartMinor: row.interestPartMinor,
        totalMinor: row.totalMinor,
        balanceAfterMinor: row.balanceAfterMinor,
        status: "DUE",
      })),
      skipDuplicates: true,
    });

    // Our cash out, customer's debt to us in. Balanced by construction.
    await postLedger(
      {
        loanId,
        lines: disbursementPosting(loan.principalMinor),
        correlationId,
        memo: `Disbursement to ${beneficiary} (${result.providerRef})`,
      },
      tx,
    );

    await transitionLoan(loanId, "ACTIVE", tx);
  });

  await notifications.add(
    "loan-active",
    {
      channel: "sms",
      template: "loan-active",
      to:
        loan.offer.application.contactPhone ??
        loan.offer.application.customer?.phone ??
        "+46700000000",
      correlationId,
      data: { loanId, beneficiary },
    },
    BEST_EFFORT_JOB_OPTS,
  );

  log("disbursement", correlationId, `settled ${result.providerRef} — loan ACTIVE`);
}

async function ensureActive(loanId: string, correlationId: string): Promise<void> {
  const loan = await prisma.loan.findUniqueOrThrow({
    where: { id: loanId },
    select: { status: true },
  });
  if (loan.status === "DISBURSING") {
    await transitionLoan(loanId, "ACTIVE");
    log("disbursement", correlationId, "reconciled stuck DISBURSING -> ACTIVE");
  }
}

function startOfDayUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}
