/**
 * Outbox relay.
 *
 * Polls the outbox table and pushes PENDING rows into BullMQ. This is the half
 * that knows about Redis — @refi/db stays queue-agnostic and hands us claimed
 * rows through `relayOutboxBatch`.
 *
 * A short poll interval is fine: the claim is cheap (an indexed partial scan)
 * and `FOR UPDATE SKIP LOCKED` means several relays never collide. In a larger
 * system you'd also trigger a poll on NOTIFY to cut latency, but polling alone
 * is correct and simple.
 */

import { Queue } from "bullmq";
import { DURABLE_JOB_OPTS, type QueueName } from "@refi/domain";
import { relayOutboxBatch, type ClaimedOutbox } from "@refi/db";
import { connection } from "./connection.js";

const queues = new Map<string, Queue>();

function queue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection });
    queues.set(name, q);
  }
  return q;
}

/** Push one claimed outbox row into its queue, preserving the dedupe jobId. */
async function dispatch(row: ClaimedOutbox): Promise<void> {
  await queue(row.queue as QueueName).add(row.jobName, row.payload, {
    ...DURABLE_JOB_OPTS,
    ...(row.jobId ? { jobId: row.jobId } : {}),
  });
}

let running = false;

/**
 * Start the relay loop.
 *
 * `running` guards against overlap — if a batch takes longer than the interval,
 * we don't start a second concurrent pass. Drains greedily: as long as a batch
 * comes back full, keep going before sleeping.
 */
export function startOutboxRelay(intervalMs = 1_000): () => void {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      let dispatched: number;
      do {
        dispatched = await relayOutboxBatch(dispatch);
        if (dispatched > 0) {
          console.log(`[relay] dispatched ${dispatched} outbox event(s)`);
        }
      } while (dispatched >= 20); // full batch -> more may be waiting
    } catch (error) {
      console.error("[relay] error:", (error as Error).message);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  // Kick once immediately so a job enqueued just before startup isn't delayed.
  void tick();

  return () => clearInterval(handle);
}
