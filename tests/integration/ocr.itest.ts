/**
 * OCR + consolidation — against a real database.
 *
 * An application can carry several statements (the cart). The processor must
 * only advance to OCR_DONE once EVERY statement is read, and the consolidated
 * figures must be the sum of balances and the balance-WEIGHTED average rate.
 * Advancing early would underwrite against partial debt.
 */

import { describe, expect, it } from "vitest";
import { processOcr } from "../../apps/worker/src/processors/ocr.js";
import { prisma } from "./db.js";
import { fakeJob, makeApplication } from "./factory.js";

async function addStatement(applicationId: string, fileRef: string) {
  return prisma.statementUpload.create({
    data: { applicationId, fileRef, ocrStatus: "PENDING" },
  });
}

function ocrJob(applicationId: string, statementId: string, fileRef: string, correlationId: string) {
  return fakeJob({ applicationId, statementId, fileRef, correlationId });
}

describe("ocr + consolidation", () => {
  it("waits for the whole cart before advancing", async () => {
    const app = await makeApplication({ status: "STATEMENT_UPLOADED" });
    const a = await addStatement(app.id, "resurs-bank__a.jpg");
    const b = await addStatement(app.id, "klarna__b.jpg");

    await processOcr(ocrJob(app.id, a.id, a.fileRef, app.correlationId));

    // One statement read — must NOT have advanced yet.
    let current = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(current.status).toBe("STATEMENT_UPLOADED");

    await processOcr(ocrJob(app.id, b.id, b.fileRef, app.correlationId));

    current = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(current.status).toBe("OCR_DONE");
  });

  it("consolidates to a balance-weighted average rate", async () => {
    const app = await makeApplication({ status: "STATEMENT_UPLOADED" });
    const a = await addStatement(app.id, "resurs-bank__a.jpg");
    const b = await addStatement(app.id, "klarna__b.jpg");

    await processOcr(ocrJob(app.id, a.id, a.fileRef, app.correlationId));
    await processOcr(ocrJob(app.id, b.id, b.fileRef, app.correlationId));

    const statements = await prisma.statementUpload.findMany({ where: { applicationId: app.id } });
    const done = statements.filter((s) => s.ocrStatus === "DONE");
    const totalBalance = done.reduce((s, r) => s + (r.extractedBalanceMinor ?? 0), 0);
    const rates = done.map((r) => r.extractedAprBps ?? 0);

    const current = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    // Sum of balances...
    expect(current.existingBalanceMinor).toBe(totalBalance);
    // ...and a weighted rate that lies between the two source rates.
    expect(current.existingAprBps!).toBeGreaterThanOrEqual(Math.min(...rates));
    expect(current.existingAprBps!).toBeLessThanOrEqual(Math.max(...rates));
  });

  it("rejects the application when every statement is unreadable", async () => {
    const app = await makeApplication({ status: "STATEMENT_UPLOADED" });
    const a = await addStatement(app.id, "resurs-bank__lowconf.jpg");

    await processOcr(ocrJob(app.id, a.id, a.fileRef, app.correlationId));

    const current = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(current.status).toBe("REJECTED");
  });

  it("is idempotent — re-running a statement does not corrupt the total", async () => {
    const app = await makeApplication({ status: "STATEMENT_UPLOADED" });
    const a = await addStatement(app.id, "resurs-bank__a.jpg");
    const job = ocrJob(app.id, a.id, a.fileRef, app.correlationId);

    await processOcr(job);
    const first = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });

    await processOcr(job); // replay
    const second = await prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } });

    expect(second.existingBalanceMinor).toBe(first.existingBalanceMinor);
    expect(second.existingAprBps).toBe(first.existingAprBps);
  });
});
