/**
 * BankID authentication routes.
 *
 * Note what is NOT here: any retry policy, any queue. BankID is
 * user-in-the-loop and short-TTL — a retry means a new order and fresh human
 * consent, so it stays in the request path. Contrast with disbursement, which
 * is queued precisely because it must survive without the user.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { collectSchema, startAuthSchema } from "@refi/domain";
import { getAdapters } from "@refi/adapters";
import { encryptPii, prisma } from "@refi/db";
import { clientIp, createSession, hashPersonalNumber } from "../auth.js";

export const authRoutes = new Hono();

/** Start a BankID auth order. */
authRoutes.post("/start", zValidator("json", startAuthSchema), async (c) => {
  const { identity } = getAdapters();
  const body = c.req.valid("json");

  const result = await identity.startAuth({ endUserIp: body.endUserIp ?? clientIp(c) });

  await prisma.bankIdOrder.create({
    data: {
      orderRef: result.orderRef,
      purpose: "AUTH",
      status: "PENDING",
      autoStartToken: result.autoStartToken,
      qrStartToken: result.qrStartToken ?? null,
    },
  });

  return c.json({
    orderRef: result.orderRef,
    autoStartToken: result.autoStartToken,
    qrStartToken: result.qrStartToken,
    // Same-device deep link. On React Native add &redirect=<yourapp://>
    autoStartUrl: `bankid:///?autostarttoken=${result.autoStartToken}&redirect=null`,
  });
});

/**
 * Poll a BankID auth order.
 *
 * On completion we create/find the Customer and issue a session.
 *
 * The personal number comes ONLY from completionData — never from the client.
 * Everything downstream (the UC pull, KYC, the credit agreement) inherits its
 * trust from this single point.
 */
authRoutes.post("/collect", zValidator("json", collectSchema), async (c) => {
  const { identity } = getAdapters();
  const { orderRef } = c.req.valid("json");

  // The order must be one we started. Without this lookup a caller could poll
  // an arbitrary orderRef — including someone else's.
  const order = await prisma.bankIdOrder.findUnique({ where: { orderRef } });
  if (!order || order.purpose !== "AUTH") {
    return c.json({ error: "Unknown auth order" }, 404);
  }

  const result = await identity.collect(orderRef);

  if (result.status === "pending") {
    return c.json({ status: "pending", hintCode: result.hintCode });
  }

  if (result.status === "failed") {
    await prisma.bankIdOrder.update({
      where: { orderRef },
      data: { status: "FAILED", hintCode: result.hintCode },
    });
    return c.json({ status: "failed", hintCode: result.hintCode }, 400);
  }

  const { user } = result.completionData;
  const personalNumberHash = hashPersonalNumber(user.personalNumber);

  const customer = await prisma.customer.upsert({
    where: { personalNumberHash },
    create: {
      personalNumberHash,
      personalNumberEnc: encryptPii(user.personalNumber),
      displayName: user.name,
      kycStatus: "PENDING",
    },
    update: { displayName: user.name },
  });

  await prisma.bankIdOrder.update({
    where: { orderRef },
    data: {
      status: "COMPLETE",
      customerId: customer.id,
      completedAt: new Date(),
      completionData: result.completionData as unknown as object,
    },
  });

  const session = await createSession(customer.id);

  return c.json({
    status: "complete",
    token: session.token,
    expiresAt: session.expiresAt.toISOString(),
    customer: { id: customer.id, displayName: customer.displayName },
    // Returned so the demo can drive the deterministic bureau outcomes.
    personalNumber: user.personalNumber,
  });
});
