/**
 * CreditBureau — the UC port.
 *
 * UC (Enento) publishes a real developer API, but access needs a signed
 * customer agreement AND a demonstrated "legitimate need" under the Swedish
 * Credit Information Act, so the fake is the default for local development.
 *
 * The distinction that matters: a HARD pull is chargeable and leaves a
 * footprint on the customer's record. A retried job must never cause a second
 * one — the harm is not refundable.
 */

export interface ConsumerReport {
  score: number; // UC-style score, roughly 0-100 risk-of-default percentile
  riskBand: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
  monthlyDisposableIncomeMinor: number;
  existingDebtMinor: number;
  paymentRemarks: number; // betalningsanmärkningar
  /** True when this call left a footprint on the customer's credit record. */
  inquiryLogged: boolean;
  raw: unknown;
}

export interface FetchReportInput {
  personalNumber: string;
  applicationId: string;
  /** Soft = score view only, no footprint (the "score tracker" product). */
  soft?: boolean;
}

export interface CreditBureau {
  fetchConsumerReport(input: FetchReportInput): Promise<ConsumerReport>;
}

/**
 * Deterministic fake bureau.
 *
 * Same personal number always yields the same report — so demos are
 * repeatable and you can drive a specific path on command rather than
 * re-rolling until you get the outcome you wanted to show.
 *
 * Forcing an outcome (last digit of the personal number):
 *   ...0  -> VERY_HIGH risk, rejected (payment remarks)
 *   ...1  -> HIGH risk, rejected on affordability
 *   ...9  -> LOW risk, approved at the best rate
 *   other -> deterministic spread across the middle
 */
export class FakeCreditBureau implements CreditBureau {
  constructor(private readonly latencyMs = 0) {}

  async fetchConsumerReport(input: FetchReportInput): Promise<ConsumerReport> {
    await this.delay();

    const pn = input.personalNumber;
    const lastDigit = Number(pn.slice(-1));
    const seed = hash(pn);

    let score: number;
    let paymentRemarks = 0;

    if (lastDigit === 0) {
      score = 15;
      paymentRemarks = 3;
    } else if (lastDigit === 1) {
      score = 35;
    } else if (lastDigit === 9) {
      score = 95;
    } else {
      score = 45 + (seed % 45); // 45..89
    }

    const riskBand: ConsumerReport["riskBand"] =
      score >= 80 ? "LOW" : score >= 60 ? "MEDIUM" : score >= 30 ? "HIGH" : "VERY_HIGH";

    // 12 000–38 000 kr/month disposable, deterministic per person.
    const monthlyDisposableIncomeMinor = 1_200_000 + (seed % 2_600) * 1_000;
    const existingDebtMinor = (seed % 400) * 1_000_00;

    return {
      score,
      riskBand,
      monthlyDisposableIncomeMinor,
      existingDebtMinor,
      paymentRemarks,
      // A soft view leaves no footprint; a hard pull does. This flag is what
      // the idempotency guard exists to protect.
      inquiryLogged: input.soft !== true,
      raw: {
        provider: "FakeCreditBureau",
        pulledAt: new Date().toISOString(),
        applicationId: input.applicationId,
        note: "Deterministic stub. Swap for UcCreditBureau behind the same interface.",
      },
    };
  }

  private delay(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

/** Stable 32-bit hash — deterministic across processes, unlike Math.random(). */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// KYC / AML
// ---------------------------------------------------------------------------

export interface KycResult {
  status: "PASS" | "FAIL" | "MANUAL_REVIEW";
  sanctionsHit: boolean;
  pepHit: boolean;
  provider: string;
  raw: unknown;
}

export interface KycProvider {
  screen(input: { personalNumber: string; applicationId: string }): Promise<KycResult>;
}

/** Deterministic screening. Personal numbers ending in 0 land in manual review. */
export class FakeKycProvider implements KycProvider {
  constructor(private readonly latencyMs = 0) {}

  async screen(input: { personalNumber: string; applicationId: string }): Promise<KycResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const lastDigit = Number(input.personalNumber.slice(-1));
    const status: KycResult["status"] = lastDigit === 0 ? "MANUAL_REVIEW" : "PASS";

    return {
      status,
      sanctionsHit: false,
      pepHit: lastDigit === 0,
      provider: "FakeKycProvider",
      raw: { screenedAt: new Date().toISOString(), applicationId: input.applicationId },
    };
  }
}
