/**
 * OCR processor.
 *
 * Queued for latency, not durability: vision work is slow and CPU-heavy, and
 * running it inside the API would degrade every other request on the process.
 *
 * An application can carry SEVERAL statements (the cart — consolidating debts
 * from multiple lenders). So this processor handles one statement, then asks
 * whether the whole cart is now read before advancing the application. Moving
 * to OCR_DONE after the first statement would underwrite against partial debt.
 *
 * Idempotent by construction: the fake extractor is deterministic on fileRef
 * and the write is an update keyed on the statement, so a retry converges on
 * the same row rather than creating a second one.
 */

import type { Job } from "bullmq";
import type { OcrJob } from "@refi/domain";
import { getAdapters } from "@refi/adapters";
import { applyConsolidation, prisma, transitionApplication } from "@refi/db";
import { log } from "../connection.js";

const MIN_CONFIDENCE = 0.7;

export async function processOcr(job: Job<OcrJob>): Promise<void> {
  const { applicationId, statementId, fileRef, correlationId } = job.data;
  const { ocr } = getAdapters();

  log("ocr", correlationId, `extracting ${fileRef} (attempt ${job.attemptsMade + 1})`);

  const extracted = await ocr.extract({ fileRef, applicationId });

  // Low confidence is not a failure to retry — the image genuinely isn't
  // readable, so retrying burns attempts and still fails.
  if (extracted.confidence < MIN_CONFIDENCE) {
    await prisma.statementUpload.update({
      where: { id: statementId },
      data: {
        ocrStatus: "FAILED",
        confidence: extracted.confidence,
        processedAt: new Date(),
      },
    });
    log("ocr", correlationId, `low confidence ${extracted.confidence} on ${fileRef}`);
    await advanceIfCartComplete(applicationId, correlationId);
    return;
  }

  await prisma.statementUpload.update({
    where: { id: statementId },
    data: {
      ocrStatus: "DONE",
      extractedLender: extracted.lender,
      extractedBalanceMinor: extracted.balanceMinor,
      extractedAprBps: extracted.aprBps,
      confidence: extracted.confidence,
      processedAt: new Date(),
    },
  });

  log(
    "ocr",
    correlationId,
    `${extracted.lender}: ${extracted.balanceMinor / 100} kr @ ${extracted.aprBps / 100}%`,
  );

  await advanceIfCartComplete(applicationId, correlationId);
}

/**
 * Advance the application only once every statement in the cart has been read.
 *
 * Re-entrant on purpose: whichever statement finishes last triggers the move,
 * and `transitionApplication` treats a repeat of the same state as a no-op, so
 * two statements completing simultaneously cannot double-transition.
 */
async function advanceIfCartComplete(
  applicationId: string,
  correlationId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const consolidated = await applyConsolidation(applicationId, tx);
    if (!consolidated.allProcessed) {
      log("ocr", correlationId, "waiting for the rest of the cart");
      return;
    }

    // Every statement failed to read — nothing to refinance.
    if (consolidated.balanceMinor <= 0) {
      await transitionApplication(
        {
          applicationId,
          to: "REJECTED",
          reason: "No statement could be read clearly enough to assess",
          correlationId,
        },
        tx,
      );
      return;
    }

    await transitionApplication(
      {
        applicationId,
        to: "OCR_DONE",
        reason:
          consolidated.statementCount > 1
            ? `Read ${consolidated.statementCount} statements — ${
                consolidated.balanceMinor / 100
              } kr at a weighted ${consolidated.weightedAprBps / 100}%`
            : `Read statement from ${consolidated.lenderLabel}`,
        correlationId,
      },
      tx,
    );
  });
}
