import IORedis from "ioredis";

export const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  // Required by BullMQ workers — blocking commands must not give up.
  maxRetriesPerRequest: null,
});

/** Structured-ish logging. Every line carries the correlation id for tracing. */
export function log(queue: string, correlationId: string, message: string): void {
  console.log(`[${queue}] (${correlationId.slice(0, 8)}) ${message}`);
}
