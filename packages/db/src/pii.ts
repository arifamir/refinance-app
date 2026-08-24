/**
 * PII at rest.
 *
 * The personal number is needed later — the credit-check worker must send it
 * to UC — but it must not sit in the database in the clear.
 *
 * So we keep two representations:
 *   * `personalNumberHash` — deterministic, for lookup/upsert
 *   * `personalNumberEnc`  — AES-256-GCM, for the rare authorised read
 *
 * The hash alone would not do (unrecoverable); encryption alone would not do
 * (not searchable). Real deployments keep the key in a KMS/HSM and put the
 * decrypt behind an audited service — the shape here is the same, the key
 * management is not.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function key(): Buffer {
  const hex = process.env.PII_KEY;
  if (!hex) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PII_KEY must be set in production");
    }
    // Deterministic dev key so restarts can still read existing rows.
    return Buffer.alloc(32, "dev-only-pii-key");
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new Error("PII_KEY must be 32 bytes of hex (64 chars)");
  return buf;
}

/** Returns `iv.ciphertext.authTag`, all base64url. */
export function encryptPii(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, encrypted, authTag].map((b) => b.toString("base64url")).join(".");
}

export function decryptPii(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Malformed PII payload");

  const [iv, encrypted, authTag] = parts.map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv(ALGORITHM, key(), iv!);
  decipher.setAuthTag(authTag!);
  // GCM authenticates: a tampered ciphertext throws here rather than
  // returning plausible garbage.
  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString("utf8");
}
