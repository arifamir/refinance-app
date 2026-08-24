/**
 * Transactional outbox — the write side and the relay.
 *
 * See the OutboxEvent model for why this exists. In short: enqueue-after-commit
 * can lose a job if the process dies in the gap, so we persist the intent to
 * enqueue in the same transaction as the state change, then relay it.
 *
 * This module deliberately knows nothing about BullMQ. The relay takes a
 * `dispatch` callback so the queue dependency stays in the worker, and @refi/db
 * stays free of a Redis client.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export interface OutboxJob {
  queue: string;
  jobName: string;
  payload: unknown;
  /** Custom BullMQ job id, for dedupe. */
  jobId?: string;
}

/**
 * Record the intent to enqueue a job, inside the caller's transaction.
 *
 * MUST be called with the same `tx` that performs the state change, or the
 * atomicity guarantee is lost and we are back to enqueue-after-commit.
 */
export async function enqueueOutbox(
  tx: Prisma.TransactionClient,
  job: OutboxJob,
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      queue: job.queue,
      jobName: job.jobName,
      payload: job.payload as Prisma.InputJsonValue,
      jobId: job.jobId ?? null,
    },
  });
}

export interface ClaimedOutbox {
  id: string;
  queue: string;
  jobName: string;
  payload: unknown;
  jobId: string | null;
}

/**
 * Relay one batch.
 *
 * Claims up to `batchSize` PENDING rows with `FOR UPDATE SKIP LOCKED`, so
 * multiple relay loops (or multiple worker processes) never grab the same row.
 * Each claimed row is handed to `dispatch`; success marks it DISPATCHED,
 * failure returns it to PENDING for the next pass.
 *
 * Returns how many rows were dispatched, so a caller can drain in a loop.
 */
export async function relayOutboxBatch(
  dispatch: (job: ClaimedOutbox) => Promise<void>,
  batchSize = 20,
): Promise<number> {
  // Atomic claim. The nested SELECT ... FOR UPDATE SKIP LOCKED is the standard
  // Postgres work-queue pattern: it locks only the rows this relay takes and
  // skips anything another relay already holds.
  const claimed = await prisma.$queryRaw<ClaimedOutbox[]>`
    UPDATE outbox_events
    SET status = 'DISPATCHING', attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM outbox_events
      WHERE status = 'PENDING'
      ORDER BY "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, queue, "jobName", payload, "jobId"
  `;

  let dispatched = 0;

  for (const row of claimed) {
    try {
      await dispatch(row);
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { status: "DISPATCHED", dispatchedAt: new Date(), lastError: null },
      });
      dispatched += 1;
    } catch (error) {
      // Enqueue failed (Redis down, say). Return it to PENDING so the next pass
      // retries; the incremented `attempts` records how hard we've tried.
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { status: "PENDING", lastError: (error as Error).message },
      });
    }
  }

  return dispatched;
}

/** Count of rows still waiting — useful for an ops endpoint or a health check. */
export async function pendingOutboxCount(): Promise<number> {
  return prisma.outboxEvent.count({ where: { status: { in: ["PENDING", "DISPATCHING"] } } });
}
