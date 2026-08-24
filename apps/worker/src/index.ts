/**
 * Worker entrypoint.
 *
 * A SEPARATE PROCESS from the API. That physical split is the architecture:
 *   * OCR burning CPU cannot slow down a login request
 *   * workers scale independently of the API
 *   * a worker crash loses no committed obligation — the jobs are in Redis
 *
 * Concurrency and rate limits are per-queue, tuned to what each downstream
 * dependency can take rather than one global setting.
 */

import { Queue, Worker, type Job } from "bullmq";
import { QUEUE } from "@refi/domain";
import { prisma } from "@refi/db";
import { connection } from "./connection.js";
import { processOcr } from "./processors/ocr.js";
import { processCreditCheck } from "./processors/creditCheck.js";
import { processKycAml } from "./processors/kyc.js";
import { processDecision } from "./processors/decision.js";
import { processDisbursement } from "./processors/disbursement.js";
import { processCollection } from "./processors/collection.js";
import { processInterestAccrual } from "./processors/interestAccrual.js";
import { processNotification } from "./processors/notifications.js";
import { startOutboxRelay } from "./relay.js";

const workers: Worker[] = [];

function register(
  name: string,
  processor: (job: Job<any>) => Promise<unknown>,
  opts: { concurrency?: number; limiter?: { max: number; duration: number } } = {},
): void {
  const worker = new Worker(name, processor, {
    connection,
    concurrency: opts.concurrency ?? 5,
    ...(opts.limiter ? { limiter: opts.limiter } : {}),
  });

  worker.on("failed", (job, err) => {
    const attempts = job?.attemptsMade ?? 0;
    const max = job?.opts.attempts ?? 1;
    const exhausted = attempts >= max;
    console.error(
      `[${name}] job ${job?.id} failed (${attempts}/${max})${
        exhausted ? " — DEAD LETTER, needs a human" : ", will retry"
      }: ${err.message}`,
    );
  });

  worker.on("error", (err) => console.error(`[${name}] worker error:`, err.message));

  workers.push(worker);
}

// OCR is CPU-heavy — keep concurrency low so it doesn't starve the box.
register(QUEUE.ocr, processOcr, { concurrency: 2 });

// UC charges per query and rate-limits. The limiter is global across this
// worker's jobs, which an in-process throttle could not coordinate.
register(QUEUE.creditCheck, processCreditCheck, {
  concurrency: 3,
  limiter: { max: 10, duration: 1_000 },
});

register(QUEUE.kycAml, processKycAml, { concurrency: 3, limiter: { max: 10, duration: 1_000 } });
register(QUEUE.decision, processDecision, { concurrency: 5 });

// Disbursement moves real money. Serialise it — there is no upside to
// paying out concurrently, and plenty of downside.
register(QUEUE.disbursement, processDisbursement, { concurrency: 1 });

// Collection sweeps in a single pass; concurrency 1 keeps the ledger writes
// simple to reason about.
register(QUEUE.collection, processCollection, { concurrency: 1 });
register(QUEUE.interestAccrual, processInterestAccrual, { concurrency: 1 });
register(QUEUE.notifications, processNotification, { concurrency: 10 });

/**
 * Repeatable jobs.
 *
 * Redis-backed, so exactly one instance runs each occurrence no matter how
 * many worker processes are up. This is the distributed lock that naive cron
 * does not give you.
 */
async function scheduleRepeatables(): Promise<void> {
  const collection = new Queue(QUEUE.collection, { connection });
  const accrual = new Queue(QUEUE.interestAccrual, { connection });

  await collection.add(
    "scheduled-sweep",
    { correlationId: "scheduled-collection" },
    {
      repeat: { pattern: process.env.COLLECTION_CRON ?? "*/30 * * * * *" },
      // Stable jobId so restarts don't stack up duplicate schedules.
      jobId: "repeat-collection",
      removeOnComplete: { count: 20 },
    },
  );

  await accrual.add(
    "scheduled-accrual",
    { correlationId: "scheduled-accrual" },
    {
      repeat: { pattern: process.env.ACCRUAL_CRON ?? "*/60 * * * * *" },
      jobId: "repeat-accrual",
      removeOnComplete: { count: 20 },
    },
  );

  console.log(
    `[worker] repeatables scheduled (collection: ${
      process.env.COLLECTION_CRON ?? "*/30 * * * * *"
    }, accrual: ${process.env.ACCRUAL_CRON ?? "*/60 * * * * *"})`,
  );
}

await scheduleRepeatables();

// Relay committed-but-not-yet-enqueued jobs from the outbox into BullMQ.
const stopRelay = startOutboxRelay();

console.log(`[worker] ${workers.length} workers up: ${Object.values(QUEUE).join(", ")}`);
console.log("[worker] outbox relay running");

/**
 * Graceful shutdown.
 *
 * `worker.close()` waits for in-flight jobs to finish rather than killing them
 * mid-flight. Important when the in-flight job is a payment.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, draining in-flight jobs`);
  stopRelay();
  await Promise.all(workers.map((w) => w.close()));
  await prisma.$disconnect();
  connection.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
