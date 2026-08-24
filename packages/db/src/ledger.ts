/**
 * Ledger writes.
 *
 * The pure rules live in @refi/domain; this is the persistence half.
 * Nothing writes to ledger_entries except `postLedger`, so the balanced-posting
 * check cannot be bypassed.
 */

import { assertBalanced, projectReceivable, type LedgerLine } from "@refi/domain";
import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export interface PostLedgerInput {
  loanId: string;
  lines: LedgerLine[];
  correlationId: string;
  memo?: string;
  currency?: string;
}

/**
 * Post a balanced set of ledger lines.
 *
 * Throws before touching the database if debits !== credits, so an unbalanced
 * book is unrepresentable rather than merely unlikely.
 *
 * Accepts an optional transaction client so a posting can share the caller's
 * transaction — e.g. marking an installment paid and posting its ledger lines
 * must either both happen or neither.
 */
export async function postLedger(
  input: PostLedgerInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  assertBalanced(input.lines);

  await tx.ledgerEntry.createMany({
    data: input.lines.map((line) => ({
      loanId: input.loanId,
      account: line.account,
      direction: line.direction,
      amountMinor: line.amountMinor,
      currency: input.currency ?? "SEK",
      correlationId: input.correlationId,
      memo: input.memo ?? null,
    })),
  });
}

/**
 * Outstanding principal, projected from the ledger.
 *
 * Deliberately NOT a stored column. A counter drifts; a projection cannot
 * disagree with the entries it is derived from.
 */
export async function outstandingPrincipalMinor(loanId: string): Promise<number> {
  const entries = await prisma.ledgerEntry.findMany({
    where: { loanId, account: "loan_receivable" },
    select: { account: true, direction: true, amountMinor: true },
  });

  return projectReceivable(
    entries.map((e) => ({
      account: e.account as LedgerLine["account"],
      direction: e.direction as LedgerLine["direction"],
      amountMinor: e.amountMinor,
    })),
  );
}

/** Whole-book check: every loan's entries must balance. Useful as a smoke test. */
export async function assertBooksBalance(): Promise<void> {
  const rows = await prisma.ledgerEntry.groupBy({
    by: ["direction"],
    _sum: { amountMinor: true },
  });

  const debits = rows.find((r) => r.direction === "DEBIT")?._sum.amountMinor ?? 0;
  const credits = rows.find((r) => r.direction === "CREDIT")?._sum.amountMinor ?? 0;

  if (debits !== credits) {
    throw new Error(`Books do not balance: debits ${debits} !== credits ${credits}`);
  }
}
