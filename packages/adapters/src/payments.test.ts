import { describe, expect, it } from "vitest";
import { FakePaymentProvider, TransientPaymentError } from "./payments.js";

const payout = (key: string, amountMinor = 4_500_000) => ({
  idempotencyKey: key,
  amountMinor,
  currency: "SEK",
  beneficiary: "Nordax Bank",
});

describe("payment idempotency", () => {
  it("moves money exactly once no matter how often the job is replayed", async () => {
    const provider = new FakePaymentProvider();
    const key = "disburse:loan-123";

    const first = await provider.payout(payout(key));
    const second = await provider.payout(payout(key));
    const third = await provider.payout(payout(key));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(third.replayed).toBe(true);

    // Same provider reference every time — one real payment.
    expect(second.providerRef).toBe(first.providerRef);
    expect(third.providerRef).toBe(first.providerRef);
    expect(provider.movementCount(key)).toBe(1);
  });

  it("still pays only once after transient failures force BullMQ to retry", async () => {
    // This is the scenario the whole design exists for: the provider errors
    // twice, the queue retries, and the old lender is paid exactly once.
    const provider = new FakePaymentProvider({ transientFailures: 2 });
    const key = "disburse:loan-456";

    await expect(provider.payout(payout(key))).rejects.toThrow(TransientPaymentError);
    await expect(provider.payout(payout(key))).rejects.toThrow(TransientPaymentError);

    const success = await provider.payout(payout(key));
    expect(success.status).toBe("SETTLED");
    expect(success.replayed).toBe(false);

    // The retry that arrives after success must not pay again.
    const afterSuccess = await provider.payout(payout(key));
    expect(afterSuccess.replayed).toBe(true);
    expect(afterSuccess.providerRef).toBe(success.providerRef);
    expect(provider.movementCount(key)).toBe(1);
  });

  it("treats different loans as different payments", async () => {
    const provider = new FakePaymentProvider();
    const a = await provider.payout(payout("disburse:loan-a"));
    const b = await provider.payout(payout("disburse:loan-b"));

    expect(a.providerRef).not.toBe(b.providerRef);
    expect(b.replayed).toBe(false);
  });

  it("refuses a key reused with a different amount", async () => {
    // A caller bug. Paying either amount would be wrong, so refuse loudly.
    const provider = new FakePaymentProvider();
    await provider.payout(payout("disburse:loan-c", 4_500_000));

    await expect(provider.payout(payout("disburse:loan-c", 9_000_000))).rejects.toThrow(
      /different amount/,
    );
  });

  it("keys collections per installment, not per loan", async () => {
    const provider = new FakePaymentProvider();
    const collect = (key: string) => ({
      idempotencyKey: key,
      amountMinor: 113_916,
      currency: "SEK",
      mandateRef: "autogiro-1",
    });

    const m1 = await provider.collect(collect("collect:loan-x:1"));
    const m2 = await provider.collect(collect("collect:loan-x:2"));
    const m1Replay = await provider.collect(collect("collect:loan-x:1"));

    // Two separate months settle; replaying month 1 does not charge again.
    expect(m1.replayed).toBe(false);
    expect(m2.replayed).toBe(false);
    expect(m1Replay.replayed).toBe(true);
    expect(m1Replay.providerRef).toBe(m1.providerRef);
  });
});
