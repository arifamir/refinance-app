/**
 * Credit check processor — the UC consumer report.
 *
 * THE critical idempotency case in this system.
 *
 * BullMQ delivers at-least-once. A hard credit pull is chargeable AND leaves a
 * footprint on the customer's credit record. A duplicate is not merely wasteful
 * — it is an irreversible harm to the customer. You can refund a double
 * charge; you cannot un-ring a credit inquiry.
 *
 * So: check-then-call, guarded by a unique constraint on applicationId.
 */

import type { Job } from "bullmq";
import {
  assessKalp,
  explainKalp,
  type CreditCheckJob,
  type Household,
  type IncomeSource,
  type KalpBreakdown,
} from "@refi/domain";
import { getAdapters } from "@refi/adapters";
import { prisma } from "@refi/db";
import { log } from "../connection.js";

export interface CreditCheckResult {
  decision: "APPROVE" | "REJECT";
  score: number;
  riskBand: string;
  reason: string;
  monthlyDisposableIncomeMinor: number;
  kalpMinor?: number;
}

/** Cheapest money we'll lend at, and the ladder up by risk band. */
const RATE_BY_BAND: Record<string, number> = {
  LOW: 690,
  MEDIUM: 990,
  HIGH: 1_490,
  // VERY_HIGH deliberately absent — it is rejected before pricing, and the
  // fallback below must never be able to produce a 0% offer.
};

export function priceForBand(riskBand: string): number {
  return RATE_BY_BAND[riskBand] ?? 1_490;
}

export async function processCreditCheck(
  job: Job<CreditCheckJob>,
): Promise<CreditCheckResult> {
  const { applicationId, personalNumber, correlationId } = job.data;

  // --- Idempotency guard -------------------------------------------------
  // If a decision already exists, this job has run before. Return the stored
  // result rather than pulling the bureau again.
  const existing = await prisma.creditDecision.findUnique({ where: { applicationId } });
  if (existing) {
    log("credit-check", correlationId, "decision already exists — skipping bureau pull");
    return toResult(existing);
  }

  const { bureau } = getAdapters();
  log("credit-check", correlationId, `pulling UC report (attempt ${job.attemptsMade + 1})`);

  // soft: false — this IS the hard pull that leaves a footprint.
  const report = await bureau.fetchConsumerReport({
    personalNumber,
    applicationId,
    soft: false,
  });

  const application = await prisma.loanApplication.findUniqueOrThrow({
    where: { id: applicationId },
    select: {
      existingBalanceMinor: true,
      requestedTermMonths: true,
      ownsAccommodation: true,
      hasSpouse: true,
      numberOfChildren: true,
      monthlyIncomeGrossMinor: true,
      incomeSource: true,
      monthlyDebtPaymentMinor: true,
    },
  });

  const { decision, reason, kalp } = assess({
    riskBand: report.riskBand,
    paymentRemarks: report.paymentRemarks,
    application,
    offeredAprBps: priceForBand(report.riskBand),
  });

  try {
    await prisma.creditDecision.create({
      data: {
        applicationId,
        bureauScore: report.score,
        riskBand: report.riskBand,
        monthlyDisposableIncomeMinor: report.monthlyDisposableIncomeMinor,
        decision,
        reason,
        inquiryLogged: report.inquiryLogged,
        raw: report.raw as object,
        kalpMinor: kalp?.kalpMinor ?? null,
        stressedAprBps: kalp?.stressedAprBps ?? null,
        kalpBreakdown: (kalp as unknown as object) ?? undefined,
      },
    });
  } catch (error) {
    // Unique violation: another worker won the race between our check above
    // and this write. Their decision stands — re-read it rather than failing.
    const raced = await prisma.creditDecision.findUnique({ where: { applicationId } });
    if (!raced) throw error;
    log("credit-check", correlationId, "lost write race — using the winner's decision");
    return toResult(raced);
  }

  log(
    "credit-check",
    correlationId,
    `${decision} (score ${report.score}, ${report.riskBand}${
      kalp ? `, KALP ${Math.round(kalp.kalpMinor / 100)} kr` : ""
    })`,
  );

  return {
    decision,
    score: report.score,
    riskBand: report.riskBand,
    reason,
    monthlyDisposableIncomeMinor: report.monthlyDisposableIncomeMinor,
    kalpMinor: kalp?.kalpMinor,
  };
}

/**
 * One mapping from a stored decision to the processor's return value, so the
 * fresh path, the idempotent-replay path, and the lost-race path all return an
 * identical shape. (A retry that returned a different shape than the first run
 * is exactly the kind of subtle inconsistency integration tests exist to catch.)
 */
function toResult(row: {
  decision: string;
  bureauScore: number;
  riskBand: string;
  reason: string;
  monthlyDisposableIncomeMinor: number;
  kalpMinor: number | null;
}): CreditCheckResult {
  return {
    decision: row.decision as "APPROVE" | "REJECT",
    score: row.bureauScore,
    riskBand: row.riskBand,
    reason: row.reason,
    monthlyDisposableIncomeMinor: row.monthlyDisposableIncomeMinor,
    kalpMinor: row.kalpMinor ?? undefined,
  };
}

interface ApplicationFacts {
  existingBalanceMinor: number | null;
  requestedTermMonths: number;
  ownsAccommodation: boolean | null;
  hasSpouse: boolean | null;
  numberOfChildren: number | null;
  monthlyIncomeGrossMinor: number | null;
  incomeSource: string | null;
  monthlyDebtPaymentMinor: number | null;
}

/**
 * Underwriting: creditworthiness AND affordability.
 *
 * Two independent gates, and both are mandatory:
 *
 *   1. Credit history — will they repay? (bureau score, payment remarks)
 *   2. KALP — CAN they repay, after standardised living costs, stress-tested?
 *
 * The second is a statutory obligation under Swedish consumer-credit rules,
 * not a risk appetite setting. A customer with a flawless record still gets
 * declined if the numbers say they cannot afford it — that protects them, and
 * it is the whole point of the requirement.
 */
function assess(input: {
  riskBand: string;
  paymentRemarks: number;
  application: ApplicationFacts;
  offeredAprBps: number;
}): { decision: "APPROVE" | "REJECT"; reason: string; kalp: KalpBreakdown | null } {
  // --- Gate 1: credit history ---
  if (input.paymentRemarks > 0) {
    return {
      decision: "REJECT",
      reason: `${input.paymentRemarks} payment remark(s) on record`,
      kalp: null,
    };
  }

  if (input.riskBand === "VERY_HIGH") {
    return {
      decision: "REJECT",
      reason: "Risk band VERY_HIGH is outside credit policy",
      kalp: null,
    };
  }

  // --- Gate 2: KALP ---
  const household = toHousehold(input.application);
  if (!household) {
    // Refusing to guess. Assessing affordability on invented inputs would be
    // worse than not assessing it, because it would look like we had.
    return {
      decision: "REJECT",
      reason: "Affordability details incomplete — cannot assess KALP",
      kalp: null,
    };
  }

  const principalMinor = input.application.existingBalanceMinor ?? 0;
  const kalp = assessKalp({
    household,
    principalMinor,
    offeredAprBps: input.offeredAprBps,
    termMonths: input.application.requestedTermMonths,
    // We're paying these loans off, so their servicing cost goes away.
    replacedDebtMinor: input.application.monthlyDebtPaymentMinor ?? 0,
  });

  return {
    decision: kalp.passes ? "APPROVE" : "REJECT",
    reason: explainKalp(kalp),
    kalp,
  };
}

/** Null unless every answer needed for a defensible assessment is present. */
function toHousehold(a: ApplicationFacts): Household | null {
  if (
    a.ownsAccommodation === null ||
    a.hasSpouse === null ||
    a.numberOfChildren === null ||
    a.monthlyIncomeGrossMinor === null ||
    a.incomeSource === null ||
    a.monthlyDebtPaymentMinor === null
  ) {
    return null;
  }

  return {
    ownsAccommodation: a.ownsAccommodation,
    hasSpouse: a.hasSpouse,
    numberOfChildren: a.numberOfChildren,
    monthlyIncomeGrossMinor: a.monthlyIncomeGrossMinor,
    incomeSource: a.incomeSource as IncomeSource,
    monthlyDebtPaymentMinor: a.monthlyDebtPaymentMinor,
  };
}
