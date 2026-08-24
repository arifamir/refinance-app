/**
 * Re-exports the app's real db package plus a test-only hashing helper, so the
 * factory can build customers without reaching into the API's private auth
 * module. Everything else uses the genuine @refi/db surface.
 */

import { createHash } from "node:crypto";

export { prisma, encryptPii } from "@refi/db";

/** Mirrors apps/api/src/auth.ts hashPersonalNumber — kept here to avoid importing the API. */
export function hashPersonalNumberForTest(personalNumber: string): string {
  const pepper = process.env.PN_PEPPER ?? "dev-pepper-not-for-production";
  return createHash("sha256").update(`${pepper}:${personalNumber}`).digest("hex");
}
