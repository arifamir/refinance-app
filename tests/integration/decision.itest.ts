/**
 * Decision fan-in — against a real database.
 *
 * The decision processor is a BullMQ Flow parent: it must only produce an offer
 * once BOTH the credit check and KYC have succeeded, and it must reject rather
 * than proceed on incomplete or negative signals. We drive it with a stubbed
 * `getChildrenValues` so the join logic is tested directly.
 */

import { describe, expect, it } from "vitest";
import { processDecision } from "../../apps/worker/src/processors/decision.js";
import { prisma } from "./db.js";
import { fakeJob, makeApplication } from "./factory.js";

function decisionJob(applicationId: string, correlationId: string, children: unknown[]) {
  const job = fakeJob({ applicationId, correlationId });
  // Flow children are keyed "queueName:jobId"; the processor reads values only.
  job.getChildrenValues = async () =>
    Object.fromEntries(children.map((v, i) => [`child:${i}`, v]));
  return job;
}

const approvedCredit = {
  decision: "APPROVE",
  score: 82,
  riskBand: "LOW",
  reason: "Approved",
  monthlyDisposableIncomeMinor: 2_000_000,
};
const passedKyc = { status: "PASS", sanctionsHit: false, pepHit: false };

describe("decision fan-in", () => {
  it("produces an offer that beats the existing rate", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 5_000_000,
      existingAprBps: 2_495,
    });

    await processDecision(decisionJob(app.id, app.correlationId, [approvedCredit, passedKyc]));

    const updated = await prisma.loanApplication.findUniqueOrThrow({
      where: { id: app.id },
      include: { offer: true },
    });
    expect(updated.status).toBe("OFFERED");
    expect(updated.offer).not.toBeNull();
    expect(updated.offer!.offeredAprBps).toBeLessThan(app.existingAprBps!);
    expect(updated.offer!.savingMinor).toBeGreaterThan(0);
  });

  it("rejects when the credit child rejected", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 5_000_000,
      existingAprBps: 2_495,
    });

    await processDecision(
      decisionJob(app.id, app.correlationId, [
        { ...approvedCredit, decision: "REJECT", reason: "Payment remarks" },
        passedKyc,
      ]),
    );

    const updated = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(updated.status).toBe("REJECTED");
  });

  it("holds for manual review rather than rejecting on a KYC hold", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 5_000_000,
      existingAprBps: 2_495,
    });

    await processDecision(
      decisionJob(app.id, app.correlationId, [
        approvedCredit,
        { status: "MANUAL_REVIEW", sanctionsHit: false, pepHit: true },
      ]),
    );

    const updated = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    // Not a rejection — a human decides. Left UNDER_REVIEW deliberately.
    expect(updated.status).toBe("UNDER_REVIEW");
  });

  it("refuses to offer a rate no better than the customer already has", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 5_000_000,
      existingAprBps: 500, // already cheaper than any band we price
    });

    await processDecision(decisionJob(app.id, app.correlationId, [approvedCredit, passedKyc]));

    const updated = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(updated.status).toBe("REJECTED");
  });

  it("throws if a child value is missing, so the flow does not silently proceed", async () => {
    const app = await makeApplication({
      status: "UNDER_REVIEW",
      existingBalanceMinor: 5_000_000,
      existingAprBps: 2_495,
    });

    // Only the credit child present — KYC never completed.
    await expect(
      processDecision(decisionJob(app.id, app.correlationId, [approvedCredit])),
    ).rejects.toThrow();
  });
});
