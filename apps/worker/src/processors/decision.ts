/**
 * Decision processor — the fan-in.
 *
 * This is a BullMQ Flow parent: it runs ONLY after both `credit-check` and
 * `kyc-aml` have completed successfully. `getChildrenValues()` hands us their
 * return values, so there is no polling for "are both done?" and no race
 * between two half-finished assessments.
 *
 * If either child exhausts its retries, this parent never runs at all — the
 * application stays UNDER_REVIEW and shows up in the failed-jobs view rather
 * than silently proceeding on incomplete information.
 */

import type { Job } from "bullmq";
import {
  BEST_EFFORT_JOB_OPTS,
  QUEUE,
  buildSchedule,
  interestSavingMinor,
  monthlyPaymentMinor,
  type DecisionJob,
} from "@refi/domain";
import { prisma, transitionApplication } from "@refi/db";
import { Queue } from "bullmq";
import { connection, log } from "../connection.js";
import { priceForBand, type CreditCheckResult } from "./creditCheck.js";
import type { KycCheckResult } from "./kyc.js";

const OFFER_VALID_DAYS = 30;

const notifications = new Queue(QUEUE.notifications, { connection });

export async function processDecision(job: Job<DecisionJob>): Promise<void> {
  const { applicationId, correlationId } = job.data;

  // Children keyed by "queueName:jobId". Collect by shape rather than by key
  // string so a jobId change doesn't silently break the fan-in.
  const childValues = Object.values(await job.getChildrenValues<unknown>());

  const credit = childValues.find(
    (v): v is CreditCheckResult =>
      typeof v === "object" && v !== null && "riskBand" in v && "decision" in v,
  );
  const kyc = childValues.find(
    (v): v is KycCheckResult =>
      typeof v === "object" && v !== null && "sanctionsHit" in v,
  );

  if (!credit || !kyc) {
    throw new Error(
      `Decision ran without both children (credit=${!!credit}, kyc=${!!kyc}). ` +
        `Got ${childValues.length} child values.`,
    );
  }

  const application = await prisma.loanApplication.findUniqueOrThrow({
    where: { id: applicationId },
    include: { customer: true },
  });

  // --- Reject paths ------------------------------------------------------
  if (credit.decision === "REJECT") {
    await reject(applicationId, credit.reason, correlationId);
    return;
  }
  if (kyc.status === "FAIL") {
    await reject(applicationId, "KYC/AML screening failed", correlationId);
    return;
  }
  if (kyc.status === "MANUAL_REVIEW") {
    // Not a rejection — a human decides. Left UNDER_REVIEW deliberately.
    log("decision", correlationId, "KYC needs manual review — holding UNDER_REVIEW");
    return;
  }

  const principalMinor = application.existingBalanceMinor;
  const existingAprBps = application.existingAprBps;
  if (!principalMinor || existingAprBps === null) {
    throw new Error(`Application ${applicationId} reached decision without OCR data`);
  }

  // --- Price the offer ---------------------------------------------------
  const offeredAprBps = priceForBand(credit.riskBand);
  const termMonths = application.requestedTermMonths;

  // Only worth offering if we actually beat their current rate. Refinancing
  // someone onto a WORSE rate is the one outcome the product must never produce.
  if (offeredAprBps >= existingAprBps) {
    await reject(
      applicationId,
      `Cannot beat existing rate (${existingAprBps / 100}% vs our ${offeredAprBps / 100}%)`,
      correlationId,
    );
    return;
  }

  const monthly = monthlyPaymentMinor(principalMinor, offeredAprBps, termMonths);
  const savingMinor = interestSavingMinor({
    principalMinor,
    existingAprBps,
    offeredAprBps,
    termMonths,
  });

  await prisma.$transaction(async (tx) => {
    await transitionApplication(
      { applicationId, to: "APPROVED", reason: credit.reason, correlationId },
      tx,
    );

    await tx.offer.upsert({
      where: { applicationId },
      create: {
        applicationId,
        principalMinor,
        offeredAprBps,
        termMonths,
        monthlyPaymentMinor: monthly,
        savingMinor,
        status: "OFFERED",
        expiresAt: new Date(Date.now() + OFFER_VALID_DAYS * 24 * 60 * 60 * 1000),
      },
      update: {
        principalMinor,
        offeredAprBps,
        termMonths,
        monthlyPaymentMinor: monthly,
        savingMinor,
        status: "OFFERED",
      },
    });

    await transitionApplication(
      {
        applicationId,
        to: "OFFERED",
        reason: `Offered ${offeredAprBps / 100}% over ${termMonths} months`,
        correlationId,
      },
      tx,
    );
  });

  // Sanity check the schedule we're about to promise. Cheap, and it means a
  // pricing bug surfaces here rather than after the money has moved.
  const schedule = buildSchedule({
    principalMinor,
    aprBps: offeredAprBps,
    termMonths,
    firstDueDate: new Date(),
  });
  const repaid = schedule.reduce((s, r) => s + r.principalPartMinor, 0);
  if (repaid !== principalMinor) {
    throw new Error(`Schedule does not repay principal: ${repaid} !== ${principalMinor}`);
  }

  await notifications.add(
    "offer-ready",
    {
      channel: "email",
      template: "offer-ready",
      to: application.contactEmail ?? application.customer?.email ?? "customer@example.com",
      correlationId,
      data: { applicationId, monthlyPaymentMinor: monthly, savingMinor },
    },
    BEST_EFFORT_JOB_OPTS,
  );

  log(
    "decision",
    correlationId,
    `OFFERED ${offeredAprBps / 100}% (was ${existingAprBps / 100}%), saves ${savingMinor / 100} kr`,
  );
}

async function reject(
  applicationId: string,
  reason: string,
  correlationId: string,
): Promise<void> {
  await transitionApplication({ applicationId, to: "REJECTED", reason, correlationId });
  log("decision", correlationId, `REJECTED: ${reason}`);
}
