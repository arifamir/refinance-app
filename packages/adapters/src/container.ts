/**
 * Adapter wiring.
 *
 * One place decides fake-vs-real, driven by env. Both the API and the workers
 * import from here, so there is exactly one answer to "which BankID are we
 * talking to right now?".
 */

import {
  BankIdIdentityProvider,
  FakeIdentityProvider,
  type IdentityProvider,
} from "./identity.js";
import {
  FakeCreditBureau,
  FakeKycProvider,
  type CreditBureau,
  type KycProvider,
} from "./bureau.js";
import { FakeStatementOcr, type StatementOcr } from "./ocr.js";
import {
  ConsoleNotifier,
  FakePaymentProvider,
  type Notifier,
  type PaymentProvider,
} from "./payments.js";

export interface Adapters {
  identity: IdentityProvider;
  bureau: CreditBureau;
  kyc: KycProvider;
  ocr: StatementOcr;
  payments: PaymentProvider;
  notifier: Notifier;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

let cached: Adapters | null = null;

export function getAdapters(): Adapters {
  if (cached) return cached;

  const latencyMs = num(process.env.FAKE_LATENCY_MS, 800);
  const useRealBankId = process.env.USE_REAL_BANKID === "true";

  cached = {
    identity: useRealBankId
      ? new BankIdIdentityProvider({
          production: process.env.NODE_ENV === "production",
          pfx: process.env.BANKID_PFX || undefined,
          passphrase: process.env.BANKID_PASSPHRASE || undefined,
        })
      : new FakeIdentityProvider({
          collectsUntilComplete: num(process.env.FAKE_BANKID_COLLECTS_UNTIL_COMPLETE, 2),
          latencyMs: Math.min(latencyMs, 300),
        }),

    bureau: new FakeCreditBureau(latencyMs),
    kyc: new FakeKycProvider(latencyMs),
    ocr: new FakeStatementOcr(latencyMs),

    // FakePaymentProvider holds idempotency state in memory, so a worker
    // restart forgets it. The database's unique constraint on
    // Disbursement.idempotencyKey is the durable guard.
    payments: new FakePaymentProvider({
      transientFailures: num(process.env.FAKE_PAYMENT_TRANSIENT_FAILURES, 1),
      latencyMs,
    }),

    notifier: new ConsoleNotifier(),
  };

  return cached;
}
