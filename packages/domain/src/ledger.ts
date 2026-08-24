/**
 * Double-entry ledger primitives (pure).
 *
 * A loan balance is NOT a mutable counter you increment and decrement. It is a
 * projection over an append-only list of balanced entries. That gives you an
 * audit trail for free — a regulatory requirement for consumer credit — and it
 * makes "where did this money go?" answerable.
 *
 * Every posting must balance: sum(debits) === sum(credits). If it doesn't,
 * refuse to write it.
 */

export const LEDGER_ACCOUNTS = [
  "loan_receivable", // what the customer owes us (asset)
  "cash", // our bank
  "interest_income", // revenue
  "accrued_interest_receivable", // interest earned but not yet collected
  "fee_income",
] as const;

export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];
export type Direction = "DEBIT" | "CREDIT";

export interface LedgerLine {
  account: LedgerAccount;
  direction: Direction;
  amountMinor: number;
}

export class UnbalancedPostingError extends Error {
  constructor(
    readonly debits: number,
    readonly credits: number,
  ) {
    super(`Unbalanced ledger posting: debits ${debits} !== credits ${credits}`);
    this.name = "UnbalancedPostingError";
  }
}

export function sumBy(lines: LedgerLine[], direction: Direction): number {
  return lines
    .filter((l) => l.direction === direction)
    .reduce((sum, l) => sum + l.amountMinor, 0);
}

export function isBalanced(lines: LedgerLine[]): boolean {
  return sumBy(lines, "DEBIT") === sumBy(lines, "CREDIT");
}

/** Throws unless the posting balances. Call this before every ledger write. */
export function assertBalanced(lines: LedgerLine[]): void {
  if (lines.length === 0) throw new Error("Refusing to post an empty ledger entry");
  for (const line of lines) {
    if (!Number.isInteger(line.amountMinor)) {
      throw new Error(`Ledger amount must be an integer, got ${line.amountMinor}`);
    }
    if (line.amountMinor < 0) {
      // Negative amounts are ambiguous — flip the direction instead.
      throw new Error(`Ledger amount must be >= 0, got ${line.amountMinor}. Flip the direction.`);
    }
  }
  const debits = sumBy(lines, "DEBIT");
  const credits = sumBy(lines, "CREDIT");
  if (debits !== credits) throw new UnbalancedPostingError(debits, credits);
}

// --- Standard postings -----------------------------------------------------

/**
 * We pay off the customer's old lender. Our cash goes down; the customer now
 * owes us the same amount.
 */
export function disbursementPosting(principalMinor: number): LedgerLine[] {
  return [
    { account: "loan_receivable", direction: "DEBIT", amountMinor: principalMinor },
    { account: "cash", direction: "CREDIT", amountMinor: principalMinor },
  ];
}

/**
 * A monthly installment arrives. Cash up; receivable down by the principal
 * part; the interest part is our revenue.
 */
export function repaymentPosting(principalPartMinor: number, interestPartMinor: number): LedgerLine[] {
  return [
    {
      account: "cash",
      direction: "DEBIT",
      amountMinor: principalPartMinor + interestPartMinor,
    },
    { account: "loan_receivable", direction: "CREDIT", amountMinor: principalPartMinor },
    { account: "interest_income", direction: "CREDIT", amountMinor: interestPartMinor },
  ];
}

/** Daily interest accrual — earned, not yet collected. */
export function accrualPosting(interestMinor: number): LedgerLine[] {
  return [
    {
      account: "accrued_interest_receivable",
      direction: "DEBIT",
      amountMinor: interestMinor,
    },
    { account: "interest_income", direction: "CREDIT", amountMinor: interestMinor },
  ];
}

/**
 * Outstanding principal, derived from the ledger rather than stored.
 * This is the "balance is a projection" rule made concrete.
 */
export function projectReceivable(lines: LedgerLine[]): number {
  return lines
    .filter((l) => l.account === "loan_receivable")
    .reduce((sum, l) => sum + (l.direction === "DEBIT" ? l.amountMinor : -l.amountMinor), 0);
}
