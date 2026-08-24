import { describe, expect, it } from "vitest";
import {
  addMonths,
  buildSchedule,
  interestSavingMinor,
  monthlyPaymentMinor,
  totalInterestMinor,
  totalRepaidMinor,
} from "./amortization.js";

const JAN_31 = new Date(Date.UTC(2026, 0, 31));

describe("monthlyPaymentMinor", () => {
  it("matches the standard annuity formula", () => {
    // 100 000 kr @ 9.9% over 48 months -> 2 531,46 kr/month
    const payment = monthlyPaymentMinor(10_000_000, 990, 48);
    expect(payment).toBe(253_146);
  });

  it("divides evenly when the loan is interest-free", () => {
    expect(monthlyPaymentMinor(12_000, 0, 12)).toBe(1_000);
  });

  it("returns the whole principal plus interest for a one-month term", () => {
    const payment = monthlyPaymentMinor(100_000, 1200, 1);
    // one month of 12%/yr on 1000,00 kr = 10,00 kr interest
    expect(payment).toBe(101_000);
  });

  it("rejects nonsense input", () => {
    expect(() => monthlyPaymentMinor(0, 990, 48)).toThrow();
    expect(() => monthlyPaymentMinor(10_000, 990, 0)).toThrow();
    expect(() => monthlyPaymentMinor(10_000.5, 990, 12)).toThrow();
    expect(() => monthlyPaymentMinor(10_000, -1, 12)).toThrow();
  });
});

describe("buildSchedule invariants", () => {
  const cases = [
    { principalMinor: 10_000_000, aprBps: 990, termMonths: 48 },
    { principalMinor: 4_500_000, aprBps: 1_249, termMonths: 36 },
    { principalMinor: 999_999, aprBps: 2_995, termMonths: 24 },
    { principalMinor: 100_000, aprBps: 0, termMonths: 12 },
    { principalMinor: 1, aprBps: 990, termMonths: 3 },
    { principalMinor: 50_000_000, aprBps: 350, termMonths: 120 },
  ];

  for (const c of cases) {
    it(`repays exactly: ${c.principalMinor} @ ${c.aprBps}bps / ${c.termMonths}m`, () => {
      const schedule = buildSchedule({ ...c, firstDueDate: JAN_31 });

      expect(schedule).toHaveLength(c.termMonths);

      // 1. principal repaid sums to exactly the amount borrowed
      const principalRepaid = schedule.reduce((s, r) => s + r.principalPartMinor, 0);
      expect(principalRepaid).toBe(c.principalMinor);

      // 2. the loan actually closes
      expect(schedule.at(-1)!.balanceAfterMinor).toBe(0);

      // 3. no floats leaked in
      for (const row of schedule) {
        expect(Number.isInteger(row.principalPartMinor)).toBe(true);
        expect(Number.isInteger(row.interestPartMinor)).toBe(true);
        expect(Number.isInteger(row.totalMinor)).toBe(true);
        expect(row.totalMinor).toBe(row.principalPartMinor + row.interestPartMinor);
      }

      // 4. balance decreases monotonically and never goes negative
      let prev = c.principalMinor;
      for (const row of schedule) {
        expect(row.balanceAfterMinor).toBeLessThanOrEqual(prev);
        expect(row.balanceAfterMinor).toBeGreaterThanOrEqual(0);
        prev = row.balanceAfterMinor;
      }
    });
  }

  it("charges no interest on a 0% loan", () => {
    const schedule = buildSchedule({
      principalMinor: 120_000,
      aprBps: 0,
      termMonths: 12,
      firstDueDate: JAN_31,
    });
    expect(totalInterestMinor(schedule)).toBe(0);
    expect(totalRepaidMinor(schedule)).toBe(120_000);
  });

  it("front-loads interest and back-loads principal", () => {
    const schedule = buildSchedule({
      principalMinor: 10_000_000,
      aprBps: 990,
      termMonths: 48,
      firstDueDate: JAN_31,
    });
    const first = schedule[0]!;
    const last = schedule.at(-1)!;
    expect(first.interestPartMinor).toBeGreaterThan(last.interestPartMinor);
    expect(first.principalPartMinor).toBeLessThan(last.principalPartMinor);
  });
});

describe("interestSavingMinor", () => {
  it("is positive when we beat the existing rate", () => {
    const saving = interestSavingMinor({
      principalMinor: 4_500_000,
      existingAprBps: 2_495, // 24.95% store credit
      offeredAprBps: 990, // 9.9% refinanced
      termMonths: 48,
    });
    expect(saving).toBeGreaterThan(0);
  });

  it("is zero when the rates match", () => {
    const saving = interestSavingMinor({
      principalMinor: 4_500_000,
      existingAprBps: 990,
      offeredAprBps: 990,
      termMonths: 48,
    });
    expect(saving).toBe(0);
  });
});

describe("addMonths", () => {
  it("clamps to the end of a shorter month", () => {
    // Jan 31 + 1 month must be Feb 28, not Mar 3
    expect(addMonths(JAN_31, 1).toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("handles leap years", () => {
    const jan31_2028 = new Date(Date.UTC(2028, 0, 31));
    expect(addMonths(jan31_2028, 1).toISOString().slice(0, 10)).toBe("2028-02-29");
  });

  it("rolls over the year", () => {
    expect(addMonths(new Date(Date.UTC(2026, 11, 15)), 1).toISOString().slice(0, 10)).toBe(
      "2027-01-15",
    );
  });

  it("produces 48 distinct due dates", () => {
    const dates = Array.from({ length: 48 }, (_, i) => addMonths(JAN_31, i).toISOString());
    expect(new Set(dates).size).toBe(48);
  });
});
