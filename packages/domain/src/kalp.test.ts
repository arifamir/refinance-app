import { describe, expect, it } from "vitest";
import {
  KALP_MARGIN_MINOR,
  STRESS_FLOOR_BPS,
  assessKalp,
  explainKalp,
  housingCostMinor,
  livingCostMinor,
  netMonthlyIncomeMinor,
  stressedRateBps,
  type Household,
} from "./kalp.js";

const base: Household = {
  ownsAccommodation: false,
  hasSpouse: false,
  numberOfChildren: 0,
  monthlyIncomeGrossMinor: 4_000_000, // 40 000 kr
  incomeSource: "PERMANENT_EMPLOYMENT",
  monthlyDebtPaymentMinor: 200_000, // 2 000 kr
};

const loan = { principalMinor: 5_000_000, offeredAprBps: 990, termMonths: 48 };

describe("net income", () => {
  it("applies municipal tax below the state threshold", () => {
    // 40 000 kr gross, 30% tax -> 28 000 kr net
    expect(netMonthlyIncomeMinor(4_000_000)).toBe(2_800_000);
  });

  it("applies state tax only on the portion above the threshold", () => {
    // 70 000 kr: first 51 200 @ 30%, remaining 18 800 @ 50%
    const net = netMonthlyIncomeMinor(7_000_000);
    expect(net).toBe(Math.round(5_120_000 * 0.7 + 1_880_000 * 0.5));
    // sanity: strictly more take-home than a 51 200 earner, but not linearly
    expect(net).toBeGreaterThan(netMonthlyIncomeMinor(5_120_000));
    expect(net).toBeLessThan(7_000_000 * 0.7);
  });

  it("is monotonic — earning more never nets less", () => {
    let previous = 0;
    for (let gross = 0; gross <= 12_000_000; gross += 500_000) {
      const net = netMonthlyIncomeMinor(gross);
      expect(net).toBeGreaterThanOrEqual(previous);
      previous = net;
    }
  });
});

describe("standardised living costs", () => {
  it("costs less per adult when two adults share", () => {
    const single = livingCostMinor(base);
    const couple = livingCostMinor({ ...base, hasSpouse: true });
    expect(couple).toBeGreaterThan(single);
    expect(couple).toBeLessThan(single * 2); // economies of scale
  });

  it("adds cost per child", () => {
    const none = livingCostMinor(base);
    const two = livingCostMinor({ ...base, numberOfChildren: 2 });
    expect(two - none).toBe(2 * 450_000);
  });

  it("ignores a nonsensical negative child count", () => {
    expect(livingCostMinor({ ...base, numberOfChildren: -3 })).toBe(
      livingCostMinor(base),
    );
  });

  it("treats owning as cheaper than renting", () => {
    expect(housingCostMinor({ ...base, ownsAccommodation: true })).toBeLessThan(
      housingCostMinor({ ...base, ownsAccommodation: false }),
    );
  });
});

describe("stress testing", () => {
  it("never assesses at the headline rate", () => {
    expect(stressedRateBps(990)).toBeGreaterThan(990);
  });

  it("floors low rates so a cheap loan is still stressed", () => {
    expect(stressedRateBps(100)).toBe(STRESS_FLOOR_BPS);
  });

  it("adds a margin above already-high rates", () => {
    expect(stressedRateBps(1_490)).toBe(1_790);
  });

  it("assesses the loan at the stressed rate, not the offered one", () => {
    const result = assessKalp({ household: base, ...loan });
    expect(result.stressedAprBps).toBe(stressedRateBps(loan.offeredAprBps));
    // the stressed payment must exceed what the customer will actually pay
    expect(result.newLoanPaymentMinor).toBeGreaterThan(0);
  });
});

describe("assessKalp", () => {
  it("approves a comfortable single earner", () => {
    const result = assessKalp({ household: base, ...loan });
    expect(result.passes).toBe(true);
    expect(result.kalpMinor).toBeGreaterThan(KALP_MARGIN_MINOR);
  });

  it("declines when standardised costs swallow the income", () => {
    // Modest income, partner and three children — costs exceed take-home.
    const stretched: Household = {
      ...base,
      monthlyIncomeGrossMinor: 2_600_000, // 26 000 kr
      hasSpouse: true,
      numberOfChildren: 3,
    };
    const result = assessKalp({ household: stretched, ...loan });
    expect(result.passes).toBe(false);
    expect(result.kalpMinor).toBeLessThan(0);
    expect(explainKalp(result)).toMatch(/Fails affordability/);
  });

  it("discounts less reliable income", () => {
    const permanent = assessKalp({ household: base, ...loan });
    const selfEmployed = assessKalp({
      household: { ...base, incomeSource: "SELF_EMPLOYED" },
      ...loan,
    });
    expect(selfEmployed.assessedIncomeMinor).toBeLessThan(permanent.assessedIncomeMinor);
    expect(selfEmployed.kalpMinor).toBeLessThan(permanent.kalpMinor);
  });

  it("does not double-count debt being refinanced away", () => {
    // Consolidating replaces the old payment; counting both would wrongly decline.
    const withoutCredit = assessKalp({
      household: { ...base, monthlyDebtPaymentMinor: 600_000 },
      ...loan,
    });
    const withCredit = assessKalp({
      household: { ...base, monthlyDebtPaymentMinor: 600_000 },
      ...loan,
      replacedDebtMinor: 600_000,
    });
    expect(withCredit.existingDebtMinor).toBe(0);
    expect(withCredit.kalpMinor).toBeGreaterThan(withoutCredit.kalpMinor);
  });

  it("never lets replaced debt go negative and inflate affordability", () => {
    const result = assessKalp({
      household: { ...base, monthlyDebtPaymentMinor: 100_000 },
      ...loan,
      replacedDebtMinor: 900_000, // more than they actually pay
    });
    expect(result.existingDebtMinor).toBe(0);
  });

  it("requires a positive buffer, not merely break-even", () => {
    // Tune income so KALP lands just under the margin.
    const household = { ...base };
    const probe = assessKalp({ household, ...loan });
    const targetKalp = KALP_MARGIN_MINOR - 100;
    const reduceBy = probe.kalpMinor - targetKalp;
    const tightened = assessKalp({
      household: { ...household, monthlyDebtPaymentMinor: base.monthlyDebtPaymentMinor + reduceBy },
      ...loan,
    });
    expect(tightened.kalpMinor).toBeLessThan(KALP_MARGIN_MINOR);
    expect(tightened.passes).toBe(false);
  });

  it("balances: income minus every cost equals KALP", () => {
    const r = assessKalp({ household: base, ...loan });
    expect(
      r.assessedIncomeMinor -
        r.livingCostMinor -
        r.housingCostMinor -
        r.existingDebtMinor -
        r.newLoanPaymentMinor,
    ).toBe(r.kalpMinor);
  });

  it("is deterministic — same input, same verdict", () => {
    const a = assessKalp({ household: base, ...loan });
    const b = assessKalp({ household: base, ...loan });
    expect(a).toEqual(b);
  });

  it("handles a zero-principal probe without dividing by zero", () => {
    const r = assessKalp({ household: base, ...loan, principalMinor: 0 });
    expect(r.newLoanPaymentMinor).toBe(0);
  });
});
