import { describe, expect, it } from "vitest";
import {
  UnbalancedPostingError,
  accrualPosting,
  assertBalanced,
  disbursementPosting,
  isBalanced,
  projectReceivable,
  repaymentPosting,
} from "./ledger.js";
import { buildSchedule } from "./amortization.js";

describe("double-entry invariants", () => {
  it("balances every standard posting", () => {
    expect(isBalanced(disbursementPosting(4_500_000))).toBe(true);
    expect(isBalanced(repaymentPosting(80_000, 33_916))).toBe(true);
    expect(isBalanced(accrualPosting(1_234))).toBe(true);
  });

  it("refuses an unbalanced posting", () => {
    expect(() =>
      assertBalanced([
        { account: "cash", direction: "DEBIT", amountMinor: 100 },
        { account: "loan_receivable", direction: "CREDIT", amountMinor: 99 },
      ]),
    ).toThrow(UnbalancedPostingError);
  });

  it("refuses empty, negative and fractional postings", () => {
    expect(() => assertBalanced([])).toThrow();
    expect(() =>
      assertBalanced([
        { account: "cash", direction: "DEBIT", amountMinor: -100 },
        { account: "loan_receivable", direction: "CREDIT", amountMinor: -100 },
      ]),
    ).toThrow(/must be >= 0/);
    expect(() =>
      assertBalanced([
        { account: "cash", direction: "DEBIT", amountMinor: 10.5 },
        { account: "loan_receivable", direction: "CREDIT", amountMinor: 10.5 },
      ]),
    ).toThrow(/integer/);
  });
});

describe("balance as a projection", () => {
  it("returns to exactly zero after a full loan lifecycle", () => {
    // The end-to-end money invariant: disburse, then repay every installment,
    // and the receivable must land on 0 — not 1 öre, not -1 öre.
    const principalMinor = 4_500_000;
    const schedule = buildSchedule({
      principalMinor,
      aprBps: 990,
      termMonths: 48,
      firstDueDate: new Date(Date.UTC(2026, 8, 1)),
    });

    const lines = [
      ...disbursementPosting(principalMinor),
      ...schedule.flatMap((row) =>
        repaymentPosting(row.principalPartMinor, row.interestPartMinor),
      ),
    ];

    // every individual posting balanced, and so does the whole book
    expect(isBalanced(lines)).toBe(true);
    expect(projectReceivable(lines)).toBe(0);
  });

  it("shows the outstanding balance mid-life", () => {
    const lines = [
      ...disbursementPosting(1_000_000),
      ...repaymentPosting(200_000, 8_250),
    ];
    expect(projectReceivable(lines)).toBe(800_000);
  });
});
