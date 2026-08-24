/**
 * Producer-side queue handles.
 *
 * The API only ever ENQUEUES. It never processes — that is the worker's job,
 * and keeping the split physical (separate processes) is what lets the two
 * scale independently.
 */

import { FlowProducer, Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUE, type QueueName } from "@refi/domain";

export const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  // BullMQ requires this; without it blocking commands throw under load.
  maxRetriesPerRequest: null,
});

const queues = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection });
    queues.set(name, q);
  }
  return q;
}

/**
 * Flows give us fan-in: `decision` runs only after BOTH `credit-check` and
 * `kyc-aml` have succeeded. Without this we'd be polling for "are both done
 * yet?" — a race condition waiting to happen.
 */
export const flowProducer = new FlowProducer({ connection });

export async function queueCounts() {
  const names = Object.values(QUEUE) as QueueName[];
  const entries = await Promise.all(
    names.map(async (name) => {
      const counts = await queue(name).getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
      );
      return [name, counts] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  await flowProducer.close();
  connection.disconnect();
}
