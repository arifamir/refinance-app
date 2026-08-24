/**
 * API entrypoint (Hono on Node).
 *
 * The API only reads/writes Postgres and enqueues jobs. It never performs slow
 * external work, so its latency is decoupled from however slow UC, OCR or the
 * payment rail happen to be.
 *
 * The app itself lives in app.ts; this file only binds a port and manages the
 * process lifecycle, so tests can import the router without opening a socket.
 */

import { serve } from "@hono/node-server";
import { prisma } from "@refi/db";
import { app } from "./app.js";
import { closeQueues } from "./queues.js";

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
});

/** Drain in-flight requests before exiting, and close Redis/Postgres cleanly. */
async function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
