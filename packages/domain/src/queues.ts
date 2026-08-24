/**
 * Queue names and job payload contracts.
 *
 * Lives in the domain package so the API (which enqueues) and the worker
 * (which consumes) share one definition. A typo in a queue name becomes a
 * compile error rather than a job that silently never runs.
 */

export const QUEUE = {
  ocr: "ocr",
  creditCheck: "credit-check",
  kycAml: "kyc-aml",
  decision: "decision",
  disbursement: "disbursement",
  collection: "collection",
  interestAccrual: "interest-accrual",
  notifications: "notifications",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Every job carries a correlation id so one request can be traced API -> job -> ledger. */
interface BaseJob {
  correlationId: string;
}

export interface OcrJob extends BaseJob {
  applicationId: string;
  statementId: string;
  fileRef: string;
}

export interface CreditCheckJob extends BaseJob {
  applicationId: string;
  personalNumber: string;
}

export interface KycAmlJob extends BaseJob {
  applicationId: string;
  personalNumber: string;
}

/** Parent of creditCheck + kycAml. Runs only once both children succeed. */
export interface DecisionJob extends BaseJob {
  applicationId: string;
}

export interface DisbursementJob extends BaseJob {
  loanId: string;
  /**
   * Deterministic. The SAME key must be produced for every retry of this
   * disbursement, or a retry becomes a second payment to the old lender.
   */
  idempotencyKey: string;
}

export interface CollectionJob extends BaseJob {
  /** Absent on the scheduled run — it sweeps everything due. */
  loanId?: string;
}

export interface InterestAccrualJob extends BaseJob {
  asOf?: string;
}

export interface NotificationJob extends BaseJob {
  channel: "email" | "sms" | "push";
  template: string;
  to: string;
  data?: Record<string, unknown>;
}

export type JobPayloads = {
  [QUEUE.ocr]: OcrJob;
  [QUEUE.creditCheck]: CreditCheckJob;
  [QUEUE.kycAml]: KycAmlJob;
  [QUEUE.decision]: DecisionJob;
  [QUEUE.disbursement]: DisbursementJob;
  [QUEUE.collection]: CollectionJob;
  [QUEUE.interestAccrual]: InterestAccrualJob;
  [QUEUE.notifications]: NotificationJob;
};

/**
 * Deterministic idempotency key for a disbursement.
 *
 * Keyed on the loan, not on the attempt — that is the entire point. BullMQ
 * delivers at-least-once, so this key is what stands between a retry and
 * paying the old lender twice.
 */
export function disbursementIdempotencyKey(loanId: string): string {
  return `disburse:${loanId}`;
}

/** Idempotency key for collecting one specific installment. */
export function collectionIdempotencyKey(loanId: string, installmentNo: number): string {
  return `collect:${loanId}:${installmentNo}`;
}

/**
 * Convert a domain key into a BullMQ custom job id.
 *
 * BullMQ reserves `:` as its Redis key separator and rejects custom ids
 * containing one. Idempotency keys, meanwhile, are a DOMAIN concept — they go
 * to the payment provider, where `disburse:<loanId>` is the idiomatic shape.
 *
 * Keeping the two apart (rather than reusing one string for both) means the
 * transport's naming rules can never quietly change what we send to a payment
 * rail. The mapping is deterministic, so job-level dedupe still works.
 */
export function toJobId(key: string): string {
  return key.replace(/:/g, "-");
}

/**
 * Retry policy for external calls that MUST eventually complete.
 * Exponential backoff: 2s, 4s, 8s, 16s, 32s.
 */
export const DURABLE_JOB_OPTS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

/**
 * Best-effort work. Fewer retries, and failure never blocks the flow —
 * an SMS outage must not stop a loan from being disbursed.
 */
export const BEST_EFFORT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "fixed" as const, delay: 5_000 },
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 100 },
};
