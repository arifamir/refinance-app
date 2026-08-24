/**
 * Amortisation — the annuity loan.
 *
 * A fixed monthly payment M for principal P over n months at monthly rate r:
 *
 *     M = P * r / (1 - (1 + r)^-n)
 *
 * Each installment splits into interest (balance * r) and principal (M - interest).
 * The balance falls, so the interest share shrinks and the principal share grows.
 *
 * This module is PURE — no DB, no clock, no IO. That is deliberate: it is the
 * part of the system most worth unit-testing, and the part most embarrassing
 * to get wrong.
 */

import type { Bps } from "./money.js";
import { monthlyRate } from "./money.js";

export interface Installment {
  installmentNo: number;
  dueDate: Date;
  principalPartMinor: number;
  interestPartMinor: number;
  totalMinor: number;
  /** Remaining balance AFTER this installment is paid. */
  balanceAfterMinor: number;
}

export interface ScheduleInput {
  principalMinor: number;
  aprBps: Bps;
  termMonths: number;
  firstDueDate: Date;
}

/**
 * The fixed monthly annuity payment, rounded to whole minor units.
 *
 * Rounding here is the reason `buildSchedule` must force the final installment
 * to clear the balance exactly — see below.
 */
export function monthlyPaymentMinor(
  principalMinor: number,
  aprBps: Bps,
  termMonths: number,
): number {
  assertPositiveInt(principalMinor, "principalMinor");
  assertPositiveInt(termMonths, "termMonths");
  if (aprBps < 0) throw new Error(`aprBps must be >= 0, got ${aprBps}`);

  const r = monthlyRate(aprBps);
  // Interest-free loan: straight division. Guarding this avoids a 0/0 below.
  if (r === 0) return Math.ceil(principalMinor / termMonths);

  const discount = Math.pow(1 + r, -termMonths);
  return Math.round((principalMinor * r) / (1 - discount));
}

/**
 * Build the full repayment schedule.
 *
 * Invariants (asserted by the tests):
 *   1. sum(principalPart) === principalMinor  — exactly, to the öre
 *   2. balanceAfter of the final installment === 0
 *   3. every amount is an integer
 *
 * The final installment absorbs all accumulated rounding drift. Without that,
 * a 48-month loan ends with a few stray öre that never get repaid — the classic
 * "loan won't close" bug.
 */
export function buildSchedule(input: ScheduleInput): Installment[] {
  const { principalMinor, aprBps, termMonths, firstDueDate } = input;
  const payment = monthlyPaymentMinor(principalMinor, aprBps, termMonths);
  const r = monthlyRate(aprBps);

  const rows: Installment[] = [];
  let balance = principalMinor;

  for (let i = 1; i <= termMonths; i++) {
    const interestPartMinor = Math.round(balance * r);
    let principalPartMinor: number;

    if (i === termMonths) {
      // Final installment: repay whatever is left, exactly.
      principalPartMinor = balance;
    } else {
      principalPartMinor = payment - interestPartMinor;
      // Defensive: with a very high rate and short term the annuity payment can
      // fail to cover interest. Never let the balance grow (negative amortisation).
      if (principalPartMinor < 0) principalPartMinor = 0;
      if (principalPartMinor > balance) principalPartMinor = balance;
    }

    balance -= principalPartMinor;

    rows.push({
      installmentNo: i,
      dueDate: addMonths(firstDueDate, i - 1),
      principalPartMinor,
      interestPartMinor,
      totalMinor: principalPartMinor + interestPartMinor,
      balanceAfterMinor: balance,
    });
  }

  return rows;
}

/** Total interest the customer pays over the life of the loan. */
export function totalInterestMinor(schedule: Installment[]): number {
  return schedule.reduce((sum, row) => sum + row.interestPartMinor, 0);
}

/** Total of every payment made. */
export function totalRepaidMinor(schedule: Installment[]): number {
  return schedule.reduce((sum, row) => sum + row.totalMinor, 0);
}

/**
 * What the customer saves by refinancing — the whole product proposition.
 * Compares total interest on their existing loan against ours, same term.
 */
export function interestSavingMinor(params: {
  principalMinor: number;
  existingAprBps: Bps;
  offeredAprBps: Bps;
  termMonths: number;
}): number {
  const at = (aprBps: Bps) =>
    totalInterestMinor(
      buildSchedule({
        principalMinor: params.principalMinor,
        aprBps,
        termMonths: params.termMonths,
        firstDueDate: new Date(0),
      }),
    );
  return at(params.existingAprBps) - at(params.offeredAprBps);
}

/**
 * Add months in UTC, clamping to the last valid day of the target month.
 * Jan 31 + 1 month => Feb 28/29, not Mar 3.
 */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const target = new Date(Date.UTC(year, month + months, 1));
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  target.setUTCDate(Math.min(day, daysInTargetMonth));
  target.setUTCHours(
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
  return target;
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}
