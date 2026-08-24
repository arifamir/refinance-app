/**
 * KALP — "Kvar Att Leva På" (what's left to live on).
 *
 * The Swedish affordability standard. Finansinspektionen requires a lender to
 * establish that a borrower can actually service a loan *after* normal living
 * costs, using standardised reference values (Konsumentverket's cost norms)
 * rather than whatever the applicant claims they spend.
 *
 *   KALP = net income
 *        − standardised living costs (household composition)
 *        − housing costs
 *        − existing debt service
 *        − the new loan's payment, STRESS-TESTED at a higher rate
 *
 * A negative KALP means the loan is unaffordable and must be declined. This is
 * a legal obligation, not a risk preference — which is why it lives in the
 * domain layer next to the money rules and is unit-tested to death.
 *
 * The reference amounts below are illustrative figures in the right shape and
 * order of magnitude. A production system would load the current
 * Konsumentverket table for the applicable year rather than hard-code it, and
 * would version it so a historic decision can be re-derived exactly.
 */

import type { Bps } from "./money.js";
import { monthlyPaymentMinor } from "./amortization.js";

export type AccommodationType = "OWNED" | "RENTED";

export type IncomeSource =
  | "PERMANENT_EMPLOYMENT"
  | "FIXED_TERM_EMPLOYMENT"
  | "SELF_EMPLOYED"
  | "OTHER";

export interface Household {
  ownsAccommodation: boolean;
  hasSpouse: boolean;
  numberOfChildren: number;
  /** Gross (pre-tax) monthly income in minor units. */
  monthlyIncomeGrossMinor: number;
  incomeSource: IncomeSource;
  /** Existing monthly debt service across all loans, incl. guarantees. */
  monthlyDebtPaymentMinor: number;
}

// --- Konsumentverket-style reference costs (minor units / month) -----------

const COST = {
  /** Personal costs for a single adult: food, clothing, hygiene, leisure, phone. */
  adultSingle: 1_050_000, // 10 500 kr
  /** Per adult when two adults share a household — economies of scale. */
  adultCohabiting: 880_000, // 8 800 kr
  /**
   * Per child. The real table bands this by age; the apply flow only asks for a
   * count of under-18s, so this is the blended figure for that band.
   */
  child: 450_000, // 4 500 kr
  /** Shared household costs: media, insurance, consumables. */
  householdSingle: 150_000, // 1 500 kr
  householdCohabiting: 210_000, // 2 100 kr
  /** Housing. Owned assumes fee + upkeep + mortgage service. */
  housingOwned: 700_000, // 7 000 kr
  housingRented: 850_000, // 8 500 kr
} as const;

/**
 * Income reliability haircut.
 *
 * Underwriting does not treat all income as equally durable. Self-employment
 * and fixed-term contracts carry more variance, so a prudent lender discounts
 * them. Policy, not law — hence a named constant rather than buried maths.
 */
const INCOME_FACTOR: Record<IncomeSource, number> = {
  PERMANENT_EMPLOYMENT: 1.0,
  FIXED_TERM_EMPLOYMENT: 0.9,
  SELF_EMPLOYED: 0.8,
  OTHER: 0.7,
};

/**
 * Stress test.
 *
 * The customer must remain solvent if rates rise, so affordability is assessed
 * against a rate materially above the one offered: the offered rate plus 300bps,
 * floored at 8%. Never assess at the headline rate — that is precisely the
 * mistake that makes a book look fine until it isn't.
 */
export const STRESS_MARGIN_BPS = 300;
export const STRESS_FLOOR_BPS = 800;

export function stressedRateBps(offeredAprBps: Bps): Bps {
  return Math.max(offeredAprBps + STRESS_MARGIN_BPS, STRESS_FLOOR_BPS);
}

/**
 * Swedish net income, approximated.
 *
 * Two-band model: ~30% municipal tax, plus ~20% state tax above the threshold
 * ("brytpunkt"). Real systems use Skatteverket's tables. Approximation is
 * acceptable here because it is deliberately CONSERVATIVE — understating net
 * income can only make us decline a marginal loan, never approve a bad one.
 */
const MUNICIPAL_TAX = 0.3;
const STATE_TAX = 0.2;
const STATE_TAX_THRESHOLD_MINOR = 5_120_000; // ~51 200 kr/month

export function netMonthlyIncomeMinor(grossMinor: number): number {
  const base = Math.min(grossMinor, STATE_TAX_THRESHOLD_MINOR);
  const above = Math.max(0, grossMinor - STATE_TAX_THRESHOLD_MINOR);
  const net = base * (1 - MUNICIPAL_TAX) + above * (1 - MUNICIPAL_TAX - STATE_TAX);
  return Math.round(net);
}

/** Standardised living costs for this household composition. */
export function livingCostMinor(household: Household): number {
  const adults = household.hasSpouse ? 2 : 1;
  const adultCost =
    adults === 2 ? COST.adultCohabiting * 2 : COST.adultSingle;
  const householdCost =
    adults === 2 ? COST.householdCohabiting : COST.householdSingle;
  const childCost = Math.max(0, household.numberOfChildren) * COST.child;

  return adultCost + householdCost + childCost;
}

export function housingCostMinor(household: Household): number {
  return household.ownsAccommodation ? COST.housingOwned : COST.housingRented;
}

export interface KalpBreakdown {
  netIncomeMinor: number;
  /** Net income after the income-source reliability haircut. */
  assessedIncomeMinor: number;
  livingCostMinor: number;
  housingCostMinor: number;
  existingDebtMinor: number;
  newLoanPaymentMinor: number;
  /** The rate affordability was actually assessed at. */
  stressedAprBps: Bps;
  /** The bottom line. Negative means unaffordable. */
  kalpMinor: number;
  passes: boolean;
}

export interface AssessInput {
  household: Household;
  principalMinor: number;
  offeredAprBps: Bps;
  termMonths: number;
  /**
   * Debt being refinanced away. Consolidating three loans into one replaces
   * their payments, so counting both would double-count and wrongly decline.
   */
  replacedDebtMinor?: number;
}

/**
 * Minimum buffer above zero.
 *
 * Exactly-zero KALP means no margin for a broken boiler. Requiring a small
 * positive buffer is standard prudent practice.
 */
export const KALP_MARGIN_MINOR = 100_000; // 1 000 kr

/**
 * Run the affordability assessment.
 *
 * Pure and total — no clock, no IO, no randomness. Given the same household
 * and terms it always returns the same verdict, which is what makes a lending
 * decision auditable and re-derivable years later.
 */
export function assessKalp(input: AssessInput): KalpBreakdown {
  const { household, principalMinor, offeredAprBps, termMonths } = input;

  const netIncomeMinor = netMonthlyIncomeMinor(household.monthlyIncomeGrossMinor);
  const assessedIncomeMinor = Math.round(
    netIncomeMinor * INCOME_FACTOR[household.incomeSource],
  );

  const living = livingCostMinor(household);
  const housing = housingCostMinor(household);

  // Debt we're paying off stops being a cost to the customer.
  const existingDebtMinor = Math.max(
    0,
    household.monthlyDebtPaymentMinor - (input.replacedDebtMinor ?? 0),
  );

  const stressedAprBps = stressedRateBps(offeredAprBps);
  const newLoanPaymentMinor =
    principalMinor > 0
      ? monthlyPaymentMinor(principalMinor, stressedAprBps, termMonths)
      : 0;

  const kalpMinor =
    assessedIncomeMinor - living - housing - existingDebtMinor - newLoanPaymentMinor;

  return {
    netIncomeMinor,
    assessedIncomeMinor,
    livingCostMinor: living,
    housingCostMinor: housing,
    existingDebtMinor,
    newLoanPaymentMinor,
    stressedAprBps,
    kalpMinor,
    passes: kalpMinor >= KALP_MARGIN_MINOR,
  };
}

/** A one-line explanation for the decision log and the customer. */
export function explainKalp(breakdown: KalpBreakdown): string {
  const kr = (minor: number) => `${Math.round(minor / 100).toLocaleString("sv-SE")} kr`;
  if (breakdown.passes) {
    return `KALP ${kr(breakdown.kalpMinor)}/month after costs, stress-tested at ${
      breakdown.stressedAprBps / 100
    }%`;
  }
  return `Fails affordability (KALP): ${kr(
    breakdown.kalpMinor,
  )}/month left after standardised living costs, stress-tested at ${
    breakdown.stressedAprBps / 100
  }%`;
}

/**
 * The debt-payment ranges the apply flow offers.
 *
 * Buckets rather than a free number because people cannot recall the exact
 * figure. We assess on the TOP of the chosen bucket — the conservative end.
 */
export const DEBT_BUCKETS = [
  { label: "0 – 1 000 kr", maxMinor: 100_000 },
  { label: "1 000 – 2 000 kr", maxMinor: 200_000 },
  { label: "2 000 – 4 000 kr", maxMinor: 400_000 },
  { label: "4 000 – 6 000 kr", maxMinor: 600_000 },
  { label: "6 000 – 10 000 kr", maxMinor: 1_000_000 },
  { label: "More than 10 000 kr", maxMinor: 1_500_000 },
] as const;
