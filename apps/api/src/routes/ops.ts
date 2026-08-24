/**
 * Ops routes.
 *
 * Deliberately unauthenticated for the demo — in production this sits behind
 * an internal-only network boundary and staff auth. Called out rather than
 * left as an accident.
 */

import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { QUEUE, addMonths } from "@refi/domain";
import { assertBooksBalance, pendingOutboxCount, prisma } from "@refi/db";
import { queue, queueCounts } from "../queues.js";

export const opsRoutes = new Hono();

/**
 * Staff guard for the ops surface.
 *
 * These endpoints move money (trigger collection) and expose internals, so in
 * production they sit behind a network boundary AND staff auth. Here that's a
 * shared secret in `OPS_TOKEN`.
 *
 * Opt-in on purpose: with no OPS_TOKEN set the guard is disabled so the local
 * demo and smoke test keep working. That default is called out in the README
 * rather than left as a silent hole — an unset secret in production should fail
 * closed, which a real deployment enforces by always setting it.
 */
opsRoutes.use("*", async (c, next) => {
  const expected = process.env.OPS_TOKEN;
  if (!expected) return next(); // demo mode

  const provided = c.req.header("x-ops-token") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Constant-time compare — a length check first, since timingSafeEqual throws
  // on differing lengths.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
});

/** Queue depths — the cheap version of a Bull Board. */
opsRoutes.get("/queues", async (c) => c.json(await queueCounts()));

/** Failed jobs, so a dead-letter isn't invisible. */
opsRoutes.get("/queues/:name/failed", async (c) => {
  const name = c.req.param("name");
  const known = Object.values(QUEUE) as string[];
  if (!known.includes(name)) return c.json({ error: "Unknown queue" }, 404);

  const jobs = await queue(name as (typeof QUEUE)[keyof typeof QUEUE]).getFailed(0, 25);
  return c.json(
    jobs.map((j) => ({
      id: j.id,
      name: j.name,
      attemptsMade: j.attemptsMade,
      failedReason: j.failedReason,
      data: j.data,
    })),
  );
});

/**
 * Trigger a collection sweep now.
 *
 * The scheduled run is on a cron, but waiting for it in a demo is dead air.
 * The processor is the same either way.
 */
opsRoutes.post("/run-collection", async (c) => {
  const job = await queue(QUEUE.collection).add(
    "manual-sweep",
    { correlationId: `manual-${Date.now()}` },
    { removeOnComplete: true },
  );
  return c.json({ enqueued: job.id });
});

opsRoutes.post("/run-accrual", async (c) => {
  const job = await queue(QUEUE.interestAccrual).add(
    "manual-accrual",
    { correlationId: `manual-${Date.now()}` },
    { removeOnComplete: true },
  );
  return c.json({ enqueued: job.id });
});

/**
 * Simulate elapsed time by shifting a loan's due dates backwards.
 *
 * DEMO AFFORDANCE — not production behaviour, and deliberately not something
 * the collection processor knows about.
 *
 * A freshly disbursed loan has its first installment due in a month, so a
 * correct collection sweep finds nothing to do. Rather than corrupt the
 * scheduling logic to make a demo look busy, this moves the clock: shift the
 * schedule back N months and the sweep picks it up through the normal path.
 */
opsRoutes.post("/loans/:id/advance", async (c) => {
  const loanId = c.req.param("id");
  const months = Number(c.req.query("months") ?? 1);

  if (!Number.isInteger(months) || months < 1 || months > 120) {
    return c.json({ error: "months must be an integer between 1 and 120" }, 400);
  }

  const rows = await prisma.repaymentSchedule.findMany({
    where: { loanId },
    select: { id: true, dueDate: true },
  });
  if (rows.length === 0) return c.json({ error: "No schedule for that loan" }, 404);

  await prisma.$transaction(
    rows.map((row) =>
      prisma.repaymentSchedule.update({
        where: { id: row.id },
        data: { dueDate: addMonths(row.dueDate, -months) },
      }),
    ),
  );

  return c.json({ loanId, months, installmentsShifted: rows.length });
});

/**
 * Whole-book integrity check: total debits must equal total credits.
 * A one-line answer to "are the books sound?".
 */
opsRoutes.get("/books", async (c) => {
  try {
    await assertBooksBalance();
    const [loans, entries, pendingOutbox] = await Promise.all([
      prisma.loan.count(),
      prisma.ledgerEntry.count(),
      pendingOutboxCount(),
    ]);
    // A healthy system drains its outbox. A growing backlog means the relay is
    // wedged — worth surfacing next to the books.
    return c.json({ balanced: true, loans, ledgerEntries: entries, pendingOutbox });
  } catch (error) {
    return c.json({ balanced: false, error: (error as Error).message }, 500);
  }
});
