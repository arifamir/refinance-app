import { describe, expect, it } from "vitest";
import {
  collectionIdempotencyKey,
  disbursementIdempotencyKey,
  toJobId,
} from "./queues.js";

const LOAN_ID = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

describe("idempotency keys", () => {
  it("keys a disbursement on the loan, not the attempt", () => {
    // Same loan must always produce the same key, or a retry pays twice.
    expect(disbursementIdempotencyKey(LOAN_ID)).toBe(disbursementIdempotencyKey(LOAN_ID));
    expect(disbursementIdempotencyKey(LOAN_ID)).not.toBe(
      disbursementIdempotencyKey("other-loan"),
    );
  });

  it("keys collection per installment, not per loan", () => {
    // Month 2 must be collectable after month 1 rather than deduped against it.
    expect(collectionIdempotencyKey(LOAN_ID, 1)).not.toBe(
      collectionIdempotencyKey(LOAN_ID, 2),
    );
  });
});

describe("toJobId", () => {
  it("strips the colons BullMQ rejects in custom job ids", () => {
    // BullMQ reserves ':' as its Redis key separator and throws
    // "Custom Id cannot contain :" — regression guard.
    expect(toJobId(disbursementIdempotencyKey(LOAN_ID))).not.toContain(":");
    expect(toJobId(collectionIdempotencyKey(LOAN_ID, 7))).not.toContain(":");
    expect(toJobId("ocr:abc")).toBe("ocr-abc");
  });

  it("stays deterministic, so job-level dedupe still works", () => {
    expect(toJobId(disbursementIdempotencyKey(LOAN_ID))).toBe(
      toJobId(disbursementIdempotencyKey(LOAN_ID)),
    );
  });

  it("keeps distinct keys distinct", () => {
    const a = toJobId(collectionIdempotencyKey(LOAN_ID, 1));
    const b = toJobId(collectionIdempotencyKey(LOAN_ID, 2));
    expect(a).not.toBe(b);
  });

  it("leaves the domain key itself untouched", () => {
    // The provider still receives the colon form — transport rules must not
    // leak into what we send a payment rail.
    expect(disbursementIdempotencyKey(LOAN_ID)).toContain(":");
  });
});
