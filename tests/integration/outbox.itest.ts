/**
 * Transactional outbox — against a real database.
 *
 * Proves the two properties the pattern exists for:
 *   1. a job written in a transaction that ROLLS BACK is never dispatched;
 *   2. a claimed row is dispatched exactly once, and a failed dispatch returns
 *      to PENDING for a later retry.
 */

import { describe, expect, it } from "vitest";
import { enqueueOutbox, prisma, relayOutboxBatch } from "@refi/db";

describe("outbox", () => {
  it("does not dispatch a job whose transaction rolled back", async () => {
    // The whole point: the job intent is tied to the state change. If the
    // business transaction fails, the enqueue must vanish with it.
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueOutbox(tx, { queue: "disbursement", jobName: "payout", payload: { x: 1 } });
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");

    const dispatched: unknown[] = [];
    await relayOutboxBatch(async (row) => void dispatched.push(row));
    expect(dispatched).toHaveLength(0);

    const count = await prisma.outboxEvent.count();
    expect(count).toBe(0);
  });

  it("dispatches a committed job exactly once", async () => {
    await prisma.$transaction(async (tx) => {
      await enqueueOutbox(tx, {
        queue: "disbursement",
        jobName: "payout",
        jobId: "disburse-loan-1",
        payload: { loanId: "loan-1" },
      });
    });

    const dispatched: string[] = [];
    const collect = async (row: { jobId: string | null }) => {
      dispatched.push(row.jobId ?? "");
    };

    const n1 = await relayOutboxBatch(collect);
    const n2 = await relayOutboxBatch(collect); // nothing left to claim

    expect(n1).toBe(1);
    expect(n2).toBe(0);
    expect(dispatched).toEqual(["disburse-loan-1"]);

    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe("DISPATCHED");
    expect(row.dispatchedAt).not.toBeNull();
  });

  it("returns a row to PENDING when dispatch fails, then succeeds on retry", async () => {
    await prisma.$transaction(async (tx) => {
      await enqueueOutbox(tx, { queue: "disbursement", jobName: "payout", payload: { loanId: "x" } });
    });

    // First pass: dispatch throws (Redis down, say).
    await relayOutboxBatch(async () => {
      throw new Error("redis unavailable");
    });

    let row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe("PENDING"); // returned for retry
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/redis/i);

    // Second pass: dispatch succeeds.
    const n = await relayOutboxBatch(async () => {});
    expect(n).toBe(1);

    row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe("DISPATCHED");
    expect(row.attempts).toBe(2);
  });
});
