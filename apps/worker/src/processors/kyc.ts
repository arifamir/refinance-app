/**
 * KYC / AML screening.
 *
 * Same idempotency shape as the credit check: unique on applicationId, so a
 * retry re-reads rather than re-screens. Cheaper to repeat than a bureau pull,
 * but a duplicate MANUAL_REVIEW flag still creates duplicate work for a human.
 */

import type { Job } from "bullmq";
import type { KycAmlJob } from "@refi/domain";
import { getAdapters } from "@refi/adapters";
import { prisma } from "@refi/db";
import { log } from "../connection.js";

export interface KycCheckResult {
  status: "PASS" | "FAIL" | "MANUAL_REVIEW";
  sanctionsHit: boolean;
  pepHit: boolean;
}

export async function processKycAml(job: Job<KycAmlJob>): Promise<KycCheckResult> {
  const { applicationId, personalNumber, correlationId } = job.data;

  const existing = await prisma.kycCheck.findUnique({ where: { applicationId } });
  if (existing) {
    log("kyc-aml", correlationId, "already screened — skipping");
    return {
      status: existing.status as KycCheckResult["status"],
      sanctionsHit: existing.sanctionsHit,
      pepHit: existing.pepHit,
    };
  }

  const { kyc } = getAdapters();
  log("kyc-aml", correlationId, `screening (attempt ${job.attemptsMade + 1})`);

  const result = await kyc.screen({ personalNumber, applicationId });

  await prisma.kycCheck.create({
    data: {
      applicationId,
      status: result.status,
      provider: result.provider,
      sanctionsHit: result.sanctionsHit,
      pepHit: result.pepHit,
      raw: result.raw as object,
    },
  });

  log("kyc-aml", correlationId, result.status);

  return {
    status: result.status,
    sanctionsHit: result.sanctionsHit,
    pepHit: result.pepHit,
  };
}
