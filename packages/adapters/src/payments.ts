/**
 * PaymentProvider — money movement.
 *
 * Two directions:
 *   * `payout`  — we pay off the customer's old lender (disbursement)
 *   * `collect` — we pull the monthly installment (Autogiro direct debit)
 *
 * Both take an `idempotencyKey`. Real payment rails offer this exact
 * primitive, and it is the contract that makes at-least-once job delivery
 * safe: replaying a request with a key already seen returns the ORIGINAL
 * result instead of moving money a second time.
 */

export interface PayoutInput {
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  /** The old lender being paid off. */
  beneficiary: string;
}

export interface CollectInput {
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  mandateRef: string;
}

export interface PaymentResult {
  providerRef: string;
  status: "SETTLED" | "FAILED";
  /** True when this returned a cached result rather than moving money again. */
  replayed: boolean;
}

export interface PaymentProvider {
  payout(input: PayoutInput): Promise<PaymentResult>;
  collect(input: CollectInput): Promise<PaymentResult>;
}

export class TransientPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientPaymentError";
  }
}

export interface FakePaymentOptions {
  /**
   * Fail this many attempts per idempotency key before succeeding.
   *
   * Set > 0 to prove the point: BullMQ retries the job, the provider is hit
   * again with the SAME key, and the customer's old lender is still paid
   * exactly once.
   */
  transientFailures?: number;
  latencyMs?: number;
}

interface LedgerRecord {
  providerRef: string;
  status: "SETTLED" | "FAILED";
  amountMinor: number;
}

/**
 * In-memory payment rail with real idempotency semantics.
 *
 * The `settled` map is the stand-in for the provider's own idempotency store.
 * Note it is keyed ONLY by idempotencyKey — that is what makes a replay
 * return the original providerRef.
 */
export class FakePaymentProvider implements PaymentProvider {
  private settled = new Map<string, LedgerRecord>();
  private attempts = new Map<string, number>();
  private readonly transientFailures: number;
  private readonly latencyMs: number;

  constructor(opts: FakePaymentOptions = {}) {
    this.transientFailures = opts.transientFailures ?? 0;
    this.latencyMs = opts.latencyMs ?? 0;
  }

  async payout(input: PayoutInput): Promise<PaymentResult> {
    return this.execute(input.idempotencyKey, input.amountMinor, "payout");
  }

  async collect(input: CollectInput): Promise<PaymentResult> {
    return this.execute(input.idempotencyKey, input.amountMinor, "collect");
  }

  private async execute(
    idempotencyKey: string,
    amountMinor: number,
    kind: string,
  ): Promise<PaymentResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    // Replay: we have already moved this money. Return the original result.
    const existing = this.settled.get(idempotencyKey);
    if (existing) {
      if (existing.amountMinor !== amountMinor) {
        // Same key, different amount — a genuine bug in the caller. Refusing
        // is much safer than silently paying either figure.
        throw new Error(
          `Idempotency key ${idempotencyKey} reused with a different amount ` +
            `(${existing.amountMinor} then ${amountMinor})`,
        );
      }
      return { ...existing, replayed: true };
    }

    const attempt = (this.attempts.get(idempotencyKey) ?? 0) + 1;
    this.attempts.set(idempotencyKey, attempt);

    if (attempt <= this.transientFailures) {
      throw new TransientPaymentError(
        `Simulated ${kind} failure ${attempt}/${this.transientFailures} for ${idempotencyKey}`,
      );
    }

    const record: LedgerRecord = {
      providerRef: `fake-${kind}-${crypto.randomUUID()}`,
      status: "SETTLED",
      amountMinor,
    };
    this.settled.set(idempotencyKey, record);

    return { ...record, replayed: false };
  }

  /** Test helper: how many times money actually moved for this key. */
  movementCount(idempotencyKey: string): number {
    return this.settled.has(idempotencyKey) ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationInput {
  channel: "email" | "sms" | "push";
  template: string;
  to: string;
  data?: Record<string, unknown>;
}

export interface Notifier {
  send(input: NotificationInput): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  async send(input: NotificationInput): Promise<void> {
    console.log(
      `  [notify:${input.channel}] ${input.template} -> ${input.to}`,
      input.data ? JSON.stringify(input.data) : "",
    );
  }
}
