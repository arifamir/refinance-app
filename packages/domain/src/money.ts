/**
 * Money.
 *
 * Rule 1 of the whole system: money is NEVER a float.
 *
 * Everything is an integer count of **minor units** (öre for SEK), and every
 * amount carries a currency. `12.30 kr` is `1230`, not `12.3`.
 *
 * Why: 0.1 + 0.2 !== 0.3 in IEEE-754. On a loan ledger that error compounds
 * across every installment until the books don't balance.
 *
 * Scale note: we use `number` for minor units. JS integers are exact to
 * 2^53, which is ~90 trillion kr — far beyond consumer lending. A real
 * ledger at bank scale would use BigInt or Postgres NUMERIC; the trade-off
 * is BigInt's awkward JSON serialisation. Called out deliberately.
 */

export type Currency = "SEK";

/** Basis points. 1 bp = 0.01%. So 9.9% APR = 990 bps. Integers, again — no floats on rates. */
export type Bps = number;

export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

export function money(amountMinor: number, currency: Currency = "SEK"): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new Error(`Money must be an integer of minor units, got ${amountMinor}`);
  }
  return { amountMinor, currency };
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** Convert bps to a decimal rate: 990 bps -> 0.099 */
export function bpsToRate(bps: Bps): number {
  return bps / 10_000;
}

/** Monthly rate from an annual APR in bps. */
export function monthlyRate(aprBps: Bps): number {
  return bpsToRate(aprBps) / 12;
}

/** Daily rate from an annual APR in bps, on a 365-day basis. */
export function dailyRate(aprBps: Bps): number {
  return bpsToRate(aprBps) / 365;
}

/** Display only. Never do arithmetic on the output of this. */
export function formatMinor(amountMinor: number, currency: Currency = "SEK"): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const suffix = currency === "SEK" ? "kr" : currency;
  return `${sign}${grouped},${minor} ${suffix}`;
}

export function formatBps(bps: Bps): string {
  return `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;
}
