/**
 * Credit-check idempotency + KALP — against a real database.
 *
 * The critical property: a retried credit-check job must not pull the UC bureau
 * a second time, because a duplicate hard inquiry is an irreversible harm to the
 * customer. The unique constraint on CreditDecision.applicationId is the guard,
 * and this proves it holds.
 */

import { describe, expect, it } from "vitest";
import { processCreditCheck } from "../../apps/worker/src/processors/creditCheck.js";
import { prisma } from "./db.js";
import { fakeJob, makeApplication } from "./factory.js";

function creditJob(applicationId: string, personalNumber: string, correlationId: string) {
  return fakeJob({ applicationId, personalNumber, correlationId });
}

describe("credit check", () => {
  it("records exactly one decision no matter how often the job runs", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 4_500_000,
      existingAprBps: 2_495,
    });
    const job = creditJob(app.id, "199001010009", app.correlationId);

    const first = await processCreditCheck(job);
    const second = await processCreditCheck(job); // retry

    expect(second).toEqual(first);
    const decisions = await prisma.creditDecision.findMany({ where: { applicationId: app.id } });
    expect(decisions).toHaveLength(1);
  });

  it("persists the KALP assessment as regulatory evidence", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 4_500_000,
      existingAprBps: 2_495,
    });

    const result = await processCreditCheck(creditJob(app.id, "199001010019", app.correlationId));
    expect(result.decision).toBe("APPROVE");

    const decision = await prisma.creditDecision.findUniqueOrThrow({
      where: { applicationId: app.id },
    });
    // Assessed, stress-tested above the offered rate, and stored in full.
    expect(decision.kalpMinor).not.toBeNull();
    expect(decision.stressedAprBps).toBeGreaterThan(0);
    expect(decision.kalpBreakdown).not.toBeNull();
    // Hard pull leaves a footprint.
    expect(decision.inquiryLogged).toBe(true);
  });

  it("declines an unaffordable applicant even with clean credit", async () => {
    // Modest income, partner and three children — standardised costs exceed income.
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 8_000_000,
      existingAprBps: 2_495,
      kalp: {
        monthlyIncomeGrossMinor: 2_600_000, // 26 000 kr
        hasSpouse: true,
        numberOfChildren: 3,
      },
    });

    // Personal number ending 2..8 -> clean credit, mid band. Affordability is
    // the only thing that can reject here.
    const result = await processCreditCheck(creditJob(app.id, "199001010025", app.correlationId));
    expect(result.decision).toBe("REJECT");
    expect(result.reason).toMatch(/affordability|KALP/i);
  });

  it("refuses to assess when KALP answers are missing", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 4_500_000,
      existingAprBps: 2_495,
      kalp: null, // no affordability data
    });

    const result = await processCreditCheck(creditJob(app.id, "199001010025", app.correlationId));
    expect(result.decision).toBe("REJECT");
    expect(result.reason).toMatch(/incomplete|cannot assess/i);
  });

  it("rejects on payment remarks before any affordability work", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 4_500_000,
      existingAprBps: 2_495,
    });
    // Personal number ending 0 -> payment remarks in the fake bureau.
    const result = await processCreditCheck(creditJob(app.id, "199001010000", app.correlationId));
    expect(result.decision).toBe("REJECT");
    expect(result.reason).toMatch(/remark/i);
  });
});
