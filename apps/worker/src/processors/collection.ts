/**
 * Collection — pulling the monthly installment by Autogiro.
 *
 * This is the job that most justifies a real queue rather than cron.
 *
 * Naive cron across N app instances runs the sweep N times and charges every
 * customer N times. BullMQ's repeatable jobs are backed by Redis, so exactly
 * one instance owns each scheduled run. That distributed lock is the feature.
 *
 * Idempotency is per INSTALLMENT (`collect:<loanId>:<n>`), not per loan —
 * month 2 must be collectable after month 1 without being deduped against it.
 */

import type { Job } from "bullmq";
import {
  collectionIdempotencyKey,
  repaymentPosting,
  type CollectionJob,
} from "@refi/domain";
import { getAdapters } from "@refi/adapters";
import { postLedger, prisma, transitionLoan } from "@refi/db";
import { log } from "../connection.js";

export async function processCollection(job: Job<CollectionJob>): Promise<void> {
  const { loanId, correlationId } = job.data;

  // Everything due today or earlier and not yet paid. Late installments get
  // swept up automatically on the next run.
  const due = await prisma.repaymentSchedule.findMany({
    where: {
      status: { in: ["DUE", "LATE"] },
      dueDate: { lte: new Date() },
      loan: { status: "ACTIVE", ...(loanId ? { id: loanId } : {}) },
    },
    include: { loan: true },
    orderBy: [{ loanId: "asc" }, { installmentNo: "asc" }],
    take: 500,
  });

  if (due.length === 0) {
    log("collection", correlationId, "nothing due");
    return;
  }

  log("collection", correlationId, `${due.length} installment(s) due`);

  const { payments } = getAdapters();

  for (const installment of due) {
    const idempotencyKey = collectionIdempotencyKey(
      installment.loanId,
      installment.installmentNo,
    );

    // Already collected this specific installment.
    const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
    if (existing?.status === "SETTLED") continue;

    try {
      const result = await payments.collect({
        idempotencyKey,
        amountMinor: installment.totalMinor,
        currency: installment.loan.currency,
        mandateRef: `autogiro:${installment.loanId}`,
      });

      await prisma.$transaction(async (tx) => {
        await tx.payment.upsert({
          where: { idempotencyKey },
          create: {
            loanId: installment.loanId,
            scheduleId: installment.id,
            idempotencyKey,
            amountMinor: installment.totalMinor,
            currency: installment.loan.currency,
            method: "AUTOGIRO",
            status: "SETTLED",
            providerRef: result.providerRef,
            settledAt: new Date(),
          },
          update: {
            status: "SETTLED",
            providerRef: result.providerRef,
            settledAt: new Date(),
          },
        });

        await tx.repaymentSchedule.update({
          where: { id: installment.id },
          data: { status: "PAID", paidAt: new Date() },
        });

        // Cash in; receivable down by principal; interest recognised as income.
        await postLedger(
          {
            loanId: installment.loanId,
            lines: repaymentPosting(
              installment.principalPartMinor,
              installment.interestPartMinor,
            ),
            correlationId,
            memo: `Installment ${installment.installmentNo} (${result.providerRef})`,
          },
          tx,
        );
      });

      log(
        "collection",
        correlationId,
        `loan ${installment.loanId.slice(0, 8)} #${installment.installmentNo} collected ${
          installment.totalMinor / 100
        } kr`,
      );

      await closeIfFullyRepaid(installment.loanId, correlationId);
    } catch (error) {
      // One customer's failed direct debit must not abort the whole sweep.
      // Mark it LATE and carry on; the next run retries it.
      await prisma.repaymentSchedule.update({
        where: { id: installment.id },
        data: { status: "LATE" },
      });
      log(
        "collection",
        correlationId,
        `loan ${installment.loanId.slice(0, 8)} #${installment.installmentNo} FAILED: ${
          (error as Error).message
        }`,
      );
    }
  }
}

async function closeIfFullyRepaid(loanId: string, correlationId: string): Promise<void> {
  const outstanding = await prisma.repaymentSchedule.count({
    where: { loanId, status: { in: ["DUE", "LATE"] } },
  });
  if (outstanding > 0) return;

  await transitionLoan(loanId, "CLOSED");
  log("collection", correlationId, `loan ${loanId.slice(0, 8)} fully repaid -> CLOSED`);
}
