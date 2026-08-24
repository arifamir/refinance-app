/**
 * Zod schemas — the boundary contract.
 *
 * One definition gives us runtime validation AND the static type. Nothing
 * untrusted enters the system without passing through here.
 */

import { z } from "zod";

/**
 * Swedish personal number, 12 digits (YYYYMMDDNNNN).
 *
 * NOTE: we validate the shape here, but the application NEVER trusts a
 * personal number sent by a client. The only one we act on comes from a
 * completed BankID order.
 */
export const personalNumberSchema = z
  .string()
  .regex(/^(19|20)\d{10}$/, "Expected a 12-digit Swedish personal number (YYYYMMDDNNNN)");

export const startAuthSchema = z.object({
  endUserIp: z.string().ip().optional(),
});

export const collectSchema = z.object({
  orderRef: z.string().min(1),
});

export const createApplicationSchema = z.object({
  requestedTermMonths: z.number().int().min(6).max(120).default(48),
});

export const uploadStatementSchema = z.object({
  /**
   * Stand-in for an object-storage reference. Real system: the client uploads
   * straight to S3/GCS with a signed URL and posts the key here — statement
   * images are PII and never belong in the database.
   */
  fileRef: z.string().min(1),
});

export const startSignSchema = z.object({
  endUserIp: z.string().ip().optional(),
});

/**
 * The KALP affordability questionnaire.
 *
 * Collected as one payload rather than a request per screen: the UI walks the
 * customer through them one at a time, but a half-saved affordability
 * assessment is worse than none, so it lands atomically.
 */
export const kalpAnswersSchema = z.object({
  ownsAccommodation: z.boolean(),
  hasSpouse: z.boolean(),
  numberOfChildren: z.number().int().min(0).max(12),
  /** Gross monthly income in minor units (öre). */
  monthlyIncomeGrossMinor: z.number().int().min(0).max(100_000_00 * 100),
  incomeSource: z.enum([
    "PERMANENT_EMPLOYMENT",
    "FIXED_TERM_EMPLOYMENT",
    "SELF_EMPLOYED",
    "OTHER",
  ]),
  /** Top of the selected bucket — we assess the conservative end. */
  monthlyDebtPaymentMinor: z.number().int().min(0),
});

export const contactSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(6).max(20).optional(),
});

/** Presented by the authenticated app to attach an anonymous lead to a customer. */
export const claimSchema = z.object({
  claimToken: z.string().min(1),
});

export type KalpAnswersInput = z.infer<typeof kalpAnswersSchema>;
export type ContactInput = z.infer<typeof contactSchema>;

export const applicationIdSchema = z.object({ id: z.string().uuid() });

// --- Response shapes (also used by the web client) -------------------------

export const installmentDtoSchema = z.object({
  installmentNo: z.number().int(),
  dueDate: z.string(),
  principalPartMinor: z.number().int(),
  interestPartMinor: z.number().int(),
  totalMinor: z.number().int(),
  balanceAfterMinor: z.number().int(),
  status: z.string(),
});

export type StartAuthInput = z.infer<typeof startAuthSchema>;
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UploadStatementInput = z.infer<typeof uploadStatementSchema>;
/** Wire shape of an installment. Distinct from the domain `Installment`, whose dueDate is a Date. */
export type InstallmentDto = z.infer<typeof installmentDtoSchema>;
