/**
 * Offer routes — accepting an offer means signing a credit agreement.
 *
 * This is where the two halves of the design meet:
 *   * signing is synchronous and user-in-the-loop (BankID, no retries)
 *   * disbursement is queued and durable (must survive a crash)
 *
 * The handover point is exactly the `ACCEPTED` transition.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  QUEUE,
  collectSchema,
  disbursementIdempotencyKey,
  formatBps,
  formatMinor,
  startSignSchema,
  toJobId,
} from "@refi/domain";
import { getAdapters } from "@refi/adapters";
import { enqueueOutbox, prisma, transitionApplication } from "@refi/db";
import { clientIp, requireAuth, type AuthEnv } from "../auth.js";

export const offerRoutes = new Hono<AuthEnv>();

offerRoutes.use("*", requireAuth);

async function loadOffer(offerId: string, customerId: string) {
  return prisma.offer.findFirst({
    where: { id: offerId, application: { customerId } },
    include: { application: true },
  });
}

/**
 * Start the BankID sign order.
 *
 * `userVisibleData` carries the ACTUAL terms, because that text is what
 * renders on the customer's phone and what the signature attests to. Signing
 * a blank or generic string would make the agreement worthless as evidence.
 */
offerRoutes.post("/:id/sign/start", zValidator("json", startSignSchema), async (c) => {
  const offer = await loadOffer(c.req.param("id"), c.get("customerId"));
  if (!offer) return c.json({ error: "Not found" }, 404);

  if (offer.status !== "OFFERED") {
    return c.json({ error: `Offer is ${offer.status}` }, 409);
  }
  if (offer.expiresAt < new Date()) {
    await transitionApplication({
      applicationId: offer.applicationId,
      to: "EXPIRED",
      reason: "Offer expired before signing",
    });
    return c.json({ error: "Offer expired" }, 409);
  }

  const terms =
    `Refinansiering ${formatMinor(offer.principalMinor)}\n` +
    `Ränta ${formatBps(offer.offeredAprBps)}\n` +
    `${offer.termMonths} månader\n` +
    `Månadsbetalning ${formatMinor(offer.monthlyPaymentMinor)}`;

  const { identity } = getAdapters();
  const body = c.req.valid("json");
  const result = await identity.startSign({
    endUserIp: body.endUserIp ?? clientIp(c),
    userVisibleData: terms,
  });

  await prisma.bankIdOrder.create({
    data: {
      orderRef: result.orderRef,
      purpose: "SIGN",
      status: "PENDING",
      autoStartToken: result.autoStartToken,
      qrStartToken: result.qrStartToken ?? null,
      customerId: c.get("customerId"),
      applicationId: offer.applicationId,
    },
  });

  await transitionApplication({
    applicationId: offer.applicationId,
    to: "SIGNING",
    reason: "BankID sign order opened",
    correlationId: offer.application.correlationId,
  });

  return c.json({
    orderRef: result.orderRef,
    autoStartToken: result.autoStartToken,
    autoStartUrl: `bankid:///?autostarttoken=${result.autoStartToken}&redirect=null`,
    termsShownToUser: terms,
  });
});

/**
 * Poll the sign order. On completion the offer is accepted and — only then —
 * the disbursement is queued.
 */
offerRoutes.post("/:id/sign/collect", zValidator("json", collectSchema), async (c) => {
  const offer = await loadOffer(c.req.param("id"), c.get("customerId"));
  if (!offer) return c.json({ error: "Not found" }, 404);

  const { orderRef } = c.req.valid("json");

  // Bind the order to THIS offer. Otherwise a caller could present a valid
  // orderRef from an unrelated signing and accept an offer they never signed.
  const order = await prisma.bankIdOrder.findUnique({ where: { orderRef } });
  if (!order || order.purpose !== "SIGN" || order.applicationId !== offer.applicationId) {
    return c.json({ error: "Unknown sign order for this offer" }, 404);
  }

  const { identity } = getAdapters();
  const result = await identity.collect(orderRef);

  if (result.status === "pending") {
    return c.json({ status: "pending", hintCode: result.hintCode });
  }

  if (result.status === "failed") {
    await prisma.bankIdOrder.update({
      where: { orderRef },
      data: { status: "FAILED", hintCode: result.hintCode },
    });
    // Cancelling on the phone is not a rejection — the offer stays valid and
    // the customer can try again. SIGN_FAILED -> OFFERED.
    await transitionApplication({
      applicationId: offer.applicationId,
      to: "SIGN_FAILED",
      reason: `BankID sign failed: ${result.hintCode}`,
    });
    await transitionApplication({
      applicationId: offer.applicationId,
      to: "OFFERED",
      reason: "Offer still open for a new signing attempt",
    });
    return c.json({ status: "failed", hintCode: result.hintCode }, 400);
  }

  // --- Signed. We now owe this customer a disbursement. ---
  const loan = await prisma.$transaction(async (tx) => {
    await tx.bankIdOrder.update({
      where: { orderRef },
      data: {
        status: "COMPLETE",
        completedAt: new Date(),
        completionData: result.completionData as unknown as object,
      },
    });

    await tx.offer.update({
      where: { id: offer.id },
      data: { status: "ACCEPTED", signedByOrderRef: orderRef, signedAt: new Date() },
    });

    await transitionApplication(
      {
        applicationId: offer.applicationId,
        to: "ACCEPTED",
        reason: `Credit agreement signed with BankID (${orderRef})`,
        correlationId: offer.application.correlationId,
      },
      tx,
    );

    // The loan exists before any money moves, in DISBURSING.
    const created = await tx.loan.create({
      data: {
        offerId: offer.id,
        principalMinor: offer.principalMinor,
        aprBps: offer.offeredAprBps,
        termMonths: offer.termMonths,
        status: "DISBURSING",
        correlationId: offer.application.correlationId,
      },
    });

    // Enqueue the disbursement THROUGH THE OUTBOX, in this same transaction.
    // If we enqueued to Redis after the commit and the process died in the gap,
    // we'd have a signed loan with no disbursement job — a debt we promised to
    // pay off but never do. The outbox row commits atomically with the loan;
    // the relay pushes it to BullMQ and can always retry from Postgres.
    const key = disbursementIdempotencyKey(created.id);
    await enqueueOutbox(tx, {
      queue: QUEUE.disbursement,
      jobName: "payout",
      jobId: toJobId(key),
      payload: {
        loanId: created.id,
        idempotencyKey: key,
        correlationId: offer.application.correlationId,
      },
    });

    return created;
  });

  return c.json({
    status: "complete",
    loanId: loan.id,
    signedAt: new Date().toISOString(),
  });
});

/** Customer declines. */
offerRoutes.post("/:id/decline", async (c) => {
  const offer = await loadOffer(c.req.param("id"), c.get("customerId"));
  if (!offer) return c.json({ error: "Not found" }, 404);

  await prisma.offer.update({ where: { id: offer.id }, data: { status: "DECLINED" } });
  await transitionApplication({
    applicationId: offer.applicationId,
    to: "DECLINED",
    reason: "Customer declined the offer",
  });

  return c.json({ status: "DECLINED" });
});
