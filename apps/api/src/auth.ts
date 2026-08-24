/**
 * Session handling.
 *
 * BankID proves identity once; it does not keep a session for us. After a
 * completed auth order we mint our own opaque bearer token.
 *
 * Opaque-token-in-DB rather than a JWT, deliberately: sessions are revocable
 * immediately, which matters more in a lending product than saving a lookup.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { prisma } from "@refi/db";

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Shared Hono env so every authed router agrees on what `customerId` is. */
export type AuthEnv = { Variables: { customerId: string } };

/**
 * Personal numbers are never stored in the clear. Hashing gives us lookup
 * without holding the plaintext. A real system would use a peppered KDF and
 * keep any plaintext in a separate access-controlled store.
 */
export function hashPersonalNumber(personalNumber: string): string {
  const pepper = process.env.PN_PEPPER ?? "dev-pepper-not-for-production";
  return createHash("sha256").update(`${pepper}:${personalNumber}`).digest("hex");
}

export async function createSession(customerId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { token, customerId, expiresAt } });
  return { token, expiresAt };
}

/**
 * Requires a valid session and pins `customerId` onto the context.
 *
 * Every downstream handler scopes its queries by this id — that is what stops
 * one customer reading another's application (IDOR).
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return c.json({ error: "Missing bearer token" }, 401);

  const session = await prisma.session.findUnique({
    where: { token },
    select: { customerId: true, expiresAt: true },
  });

  if (!session) return c.json({ error: "Invalid session" }, 401);
  if (session.expiresAt < new Date()) return c.json({ error: "Session expired" }, 401);

  c.set("customerId", session.customerId);
  await next();
  return;
};

/**
 * Draft capability guard for the ANONYMOUS web quiz.
 *
 * Before BankID there is no customer and no session, so quiz mutations can't be
 * scoped by customerId. Instead each draft carries an unguessable `draftToken`,
 * returned when the application is created and presented as `x-draft-token`.
 * Possession of the token is the authorisation — a capability, not an identity.
 *
 * This is why the application id alone is not enough to mutate a draft: a leaked
 * id in a URL or log cannot be acted on without the separate token.
 */
export type DraftEnv = { Variables: { applicationId: string } };

export const requireDraft: MiddlewareHandler<DraftEnv> = async (c, next) => {
  const applicationId = c.req.param("id");
  const token = c.req.header("x-draft-token");

  if (!applicationId || !token) return c.json({ error: "Missing draft token" }, 401);

  const application = await prisma.loanApplication.findUnique({
    where: { id: applicationId },
    select: { draftToken: true, customerId: true },
  });

  // Once claimed, the draft token is retired — the quiz phase is over.
  if (!application || !application.draftToken || application.customerId) {
    return c.json({ error: "Not a draft" }, 404);
  }
  if (application.draftToken !== token) {
    return c.json({ error: "Invalid draft token" }, 403);
  }

  c.set("applicationId", applicationId);
  await next();
  return;
};

/** Client IP for BankID's endUserIp. BankID rejects orders without a plausible one. */
export function clientIp(c: Context<any>): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "127.0.0.1";
}
