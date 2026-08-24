/**
 * Tiny API client.
 *
 * Types are declared locally rather than imported from @refi/domain: the web
 * app is the one place a wire boundary genuinely exists, and keeping Vite out
 * of the server packages avoids bundling Prisma into the browser.
 */

const BASE = "/api";

// Two auth mechanisms, one per phase:
//   session token  -> the authenticated app (Authorization: Bearer)
//   draft token    -> the anonymous quiz     (x-draft-token capability)
let token: string | null = sessionStorage.getItem("refi_token");

export function setToken(next: string | null): void {
  token = next;
  if (next) sessionStorage.setItem("refi_token", next);
  else sessionStorage.removeItem("refi_token");
}

export function getToken(): string | null {
  return token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

/** Authenticated-app calls — carry the session bearer. */
export const api = {
  get: <T>(path: string) => request<T>(path, { headers: authHeader() }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", headers: authHeader(), body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", headers: authHeader(), body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE", headers: authHeader() }),
};

function authHeader(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Anonymous-quiz calls — carry the draft capability token. */
export function draftApi(draftToken: string) {
  const h = { "x-draft-token": draftToken };
  return {
    get: <T>(path: string) => request<T>(path, { headers: h }),
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: "POST", headers: h, body: JSON.stringify(body ?? {}) }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: "PATCH", headers: h, body: JSON.stringify(body ?? {}) }),
    del: <T>(path: string) => request<T>(path, { method: "DELETE", headers: h }),
  };
}

/** Create an anonymous draft — the only call with no auth at all. */
export function createDraft(requestedTermMonths: number) {
  return request<{ id: string; draftToken: string }>("/applications", {
    method: "POST",
    body: JSON.stringify({ requestedTermMonths }),
  });
}

export interface UcScore {
  score: number;
  riskBand: string;
  monthlyDisposableIncomeMinor: number;
  existingDebtMinor: number;
  paymentRemarks: number;
  inquiryLogged: boolean;
}

// --- Wire types ------------------------------------------------------------

export interface BankIdStart {
  orderRef: string;
  autoStartToken: string;
  autoStartUrl: string;
  termsShownToUser?: string;
}

export type BankIdCollect =
  | { status: "pending"; hintCode: string }
  | {
      status: "complete";
      token: string;
      customer: { id: string; displayName: string | null };
      personalNumber: string;
    }
  | { status: "complete"; loanId: string; signedAt: string };

export interface Offer {
  id: string;
  principalMinor: number;
  offeredAprBps: number;
  termMonths: number;
  monthlyPaymentMinor: number;
  savingMinor: number;
  status: string;
  expiresAt: string;
}

export interface Installment {
  installmentNo: number;
  dueDate: string;
  principalPartMinor: number;
  interestPartMinor: number;
  totalMinor: number;
  balanceAfterMinor: number;
  status: string;
}

export interface ApplicationEvent {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  createdAt: string;
}

export interface Statement {
  id: string;
  fileRef: string;
  ocrStatus: string;
  extractedLender: string | null;
  extractedBalanceMinor: number | null;
  extractedAprBps: number | null;
  confidence: number | null;
}

export interface KalpAnswers {
  ownsAccommodation: boolean;
  hasSpouse: boolean;
  numberOfChildren: number;
  monthlyIncomeGrossMinor: number;
  incomeSource: string;
  monthlyDebtPaymentMinor: number;
}

export interface Application {
  id: string;
  status: string;
  requestedTermMonths: number;
  existingLender: string | null;
  existingBalanceMinor: number | null;
  existingAprBps: number | null;
  statements: Statement[];
  creditDecision: {
    bureauScore: number;
    riskBand: string;
    decision: string;
    reason: string;
    kalpMinor: number | null;
    stressedAprBps: number | null;
  } | null;
  kycCheck: { status: string } | null;
  events: ApplicationEvent[];
  offer:
    | (Offer & {
        loan: { id: string; status: string; schedule: Installment[] } | null;
      })
    | null;
}

// --- Formatting ------------------------------------------------------------

export function formatMinor(amountMinor: number): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${String(major).replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${minor} kr`;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;
}
