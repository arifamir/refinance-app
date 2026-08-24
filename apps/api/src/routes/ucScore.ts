/**
 * Standalone credit-score checker.
 *
 * A separate tool from the loan flow: an authenticated customer can view their
 * bureau score at any time. The key distinction from the loan application is
 * that this is a SOFT pull — it leaves no footprint on the customer's credit
 * record, whereas applying for a loan triggers a hard inquiry that does.
 *
 * That soft/hard difference is the whole reason `fetchConsumerReport` takes a
 * `soft` flag, and it's why a retried loan credit-check must be idempotent while
 * this endpoint can be called freely.
 */

import { Hono } from "hono";
import { decryptPii, prisma } from "@refi/db";
import { getAdapters } from "@refi/adapters";
import { requireAuth, type AuthEnv } from "../auth.js";

export const ucScoreRoutes = new Hono<AuthEnv>();

ucScoreRoutes.get("/", requireAuth, async (c) => {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: c.get("customerId") },
    select: { personalNumberEnc: true },
  });

  const { bureau } = getAdapters();
  const report = await bureau.fetchConsumerReport({
    personalNumber: decryptPii(customer.personalNumberEnc),
    applicationId: "score-check", // not tied to a loan application
    soft: true, // no footprint
  });

  return c.json({
    score: report.score,
    riskBand: report.riskBand,
    monthlyDisposableIncomeMinor: report.monthlyDisposableIncomeMinor,
    existingDebtMinor: report.existingDebtMinor,
    paymentRemarks: report.paymentRemarks,
    // Always false here — that's the point of a soft check.
    inquiryLogged: report.inquiryLogged,
  });
});
