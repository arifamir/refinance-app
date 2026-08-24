/**
 * Consolidating several statements into one refinance.
 *
 * The apply flow lets a customer add invoices from several lenders — "we will
 * compile everything in one monthly invoice for you". So the application's
 * headline figures are AGGREGATES, not one statement's values:
 *
 *   balance -> the sum
 *   rate    -> the balance-WEIGHTED average
 *
 * The weighting matters. A plain mean of 24.95% on 50 000 kr and 9% on 500 kr
 * says 17%, which would badly understate what this customer actually pays and
 * could make us "save" them money that was never being spent.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export interface Consolidated {
  balanceMinor: number;
  /** Balance-weighted average APR in basis points. */
  weightedAprBps: number;
  lenderLabel: string;
  statementCount: number;
  allProcessed: boolean;
}

export async function consolidateStatements(
  applicationId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<Consolidated> {
  const statements = await tx.statementUpload.findMany({
    where: { applicationId },
    select: {
      ocrStatus: true,
      extractedBalanceMinor: true,
      extractedAprBps: true,
      extractedLender: true,
    },
  });

  const done = statements.filter(
    (s) =>
      s.ocrStatus === "DONE" &&
      s.extractedBalanceMinor !== null &&
      s.extractedAprBps !== null,
  );

  const balanceMinor = done.reduce((sum, s) => sum + (s.extractedBalanceMinor ?? 0), 0);

  // Weighted by balance. Guard the zero case so we never divide by zero on an
  // application whose statements all read as 0 kr.
  const weightedAprBps =
    balanceMinor > 0
      ? Math.round(
          done.reduce(
            (sum, s) => sum + (s.extractedBalanceMinor ?? 0) * (s.extractedAprBps ?? 0),
            0,
          ) / balanceMinor,
        )
      : 0;

  const lenders = [...new Set(done.map((s) => s.extractedLender).filter(Boolean))];
  const lenderLabel =
    lenders.length === 0
      ? "Unknown lender"
      : lenders.length === 1
        ? lenders[0]!
        : `${lenders.length} lenders`;

  return {
    balanceMinor,
    weightedAprBps,
    lenderLabel,
    statementCount: statements.length,
    // Only true once nothing is still queued — the whole cart must be read
    // before we can assess, or we'd underwrite against partial debt.
    allProcessed:
      statements.length > 0 && statements.every((s) => s.ocrStatus !== "PENDING"),
  };
}

/** Write the aggregates back onto the application. */
export async function applyConsolidation(
  applicationId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<Consolidated> {
  const consolidated = await consolidateStatements(applicationId, tx);

  await tx.loanApplication.update({
    where: { id: applicationId },
    data: {
      existingBalanceMinor: consolidated.balanceMinor,
      existingAprBps: consolidated.weightedAprBps,
      existingLender: consolidated.lenderLabel,
    },
  });

  return consolidated;
}
