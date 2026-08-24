/**
 * State machines.
 *
 * An application is always in exactly ONE known state, and every move between
 * states is explicit. This replaces the usual pile of booleans
 * (`isApproved`, `hasSigned`, `isDisbursed`) which can express nonsense like
 * "disbursed but rejected".
 *
 * Illegal transitions throw. In a lending system that is the correct
 * behaviour: refusing to move is always safer than silently paying out.
 */

export const APPLICATION_STATES = [
  // --- Anonymous web quiz (no identity yet) ---
  "DRAFT", // created anonymously when a lender is picked
  "STATEMENT_UPLOADED", // statement image received, OCR queued
  "OCR_DONE", // balance + APR extracted; KALP + contact collected here
  "LEAD", // quiz finished — a captured lead awaiting BankID identity
  // --- Authenticated app (after BankID claims the lead) ---
  "UNDER_REVIEW", // credit check + KYC/AML running
  "APPROVED",
  "REJECTED",
  "OFFERED", // offer issued, awaiting customer
  "SIGNING", // BankID sign order open
  "ACCEPTED", // signed — we now owe them a disbursement
  "DECLINED", // customer said no
  "EXPIRED", // offer timed out
  "SIGN_FAILED", // BankID order cancelled/expired — recoverable, back to OFFERED
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATES)[number];

export const LOAN_STATES = [
  "DISBURSING", // paying off the old creditor
  "ACTIVE", // disbursed, schedule live
  "CLOSED", // fully repaid
  "DEFAULTED",
] as const;

export type LoanStatus = (typeof LOAN_STATES)[number];

const APPLICATION_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  DRAFT: ["STATEMENT_UPLOADED"],
  STATEMENT_UPLOADED: ["OCR_DONE", "REJECTED"],
  // The quiz ends at LEAD. Nothing is assessed until a verified customer claims
  // it — so OCR_DONE goes to LEAD, not straight to review.
  OCR_DONE: ["LEAD"],
  LEAD: ["UNDER_REVIEW", "EXPIRED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["OFFERED"],
  REJECTED: [],
  OFFERED: ["SIGNING", "DECLINED", "EXPIRED"],
  // A BankID order can be cancelled on the phone. That is not a rejection —
  // the offer is still good, so SIGN_FAILED loops back to OFFERED for a retry.
  SIGNING: ["ACCEPTED", "SIGN_FAILED", "EXPIRED"],
  SIGN_FAILED: ["OFFERED", "EXPIRED"],
  ACCEPTED: [], // terminal for the application; the Loan takes over
  DECLINED: [],
  EXPIRED: [],
};

const LOAN_TRANSITIONS: Record<LoanStatus, readonly LoanStatus[]> = {
  DISBURSING: ["ACTIVE"],
  ACTIVE: ["CLOSED", "DEFAULTED"],
  CLOSED: [],
  DEFAULTED: ["CLOSED"], // recovered
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransitionApplication(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return APPLICATION_TRANSITIONS[from].includes(to);
}

export function assertApplicationTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): void {
  if (!canTransitionApplication(from, to)) {
    throw new IllegalTransitionError("application", from, to);
  }
}

export function canTransitionLoan(from: LoanStatus, to: LoanStatus): boolean {
  return LOAN_TRANSITIONS[from].includes(to);
}

export function assertLoanTransition(from: LoanStatus, to: LoanStatus): void {
  if (!canTransitionLoan(from, to)) {
    throw new IllegalTransitionError("loan", from, to);
  }
}

export function isTerminalApplicationStatus(status: ApplicationStatus): boolean {
  return APPLICATION_TRANSITIONS[status].length === 0;
}

/** Human-readable progress, for the client UI. */
export function applicationProgress(status: ApplicationStatus): number {
  const order: ApplicationStatus[] = [
    "DRAFT",
    "STATEMENT_UPLOADED",
    "OCR_DONE",
    "LEAD",
    "UNDER_REVIEW",
    "APPROVED",
    "OFFERED",
    "SIGNING",
    "ACCEPTED",
  ];
  const idx = order.indexOf(status);
  if (idx === -1) return 1; // terminal-but-unhappy states are "done"
  return idx / (order.length - 1);
}
