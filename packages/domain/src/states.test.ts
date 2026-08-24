import { describe, expect, it } from "vitest";
import {
  APPLICATION_STATES,
  IllegalTransitionError,
  assertApplicationTransition,
  assertLoanTransition,
  canTransitionApplication,
  isTerminalApplicationStatus,
} from "./states.js";

describe("application state machine", () => {
  it("walks the happy path", () => {
    const happy = [
      "DRAFT",
      "STATEMENT_UPLOADED",
      "OCR_DONE",
      "LEAD",
      "UNDER_REVIEW",
      "APPROVED",
      "OFFERED",
      "SIGNING",
      "ACCEPTED",
    ] as const;

    for (let i = 0; i < happy.length - 1; i++) {
      expect(() => assertApplicationTransition(happy[i]!, happy[i + 1]!)).not.toThrow();
    }
  });

  it("refuses to skip the credit check", () => {
    // The bug that pays out to an unassessed customer.
    expect(() => assertApplicationTransition("DRAFT", "ACCEPTED")).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertApplicationTransition("OCR_DONE", "APPROVED")).toThrow();
    expect(() => assertApplicationTransition("OFFERED", "ACCEPTED")).toThrow();
  });

  it("does not assess an unclaimed lead — LEAD must pass through review", () => {
    // A lead has no verified identity, so it cannot jump to a decision.
    expect(() => assertApplicationTransition("OCR_DONE", "UNDER_REVIEW")).toThrow();
    expect(() => assertApplicationTransition("LEAD", "UNDER_REVIEW")).not.toThrow();
    expect(() => assertApplicationTransition("LEAD", "APPROVED")).toThrow();
  });

  it("never un-rejects an application", () => {
    for (const to of APPLICATION_STATES) {
      expect(canTransitionApplication("REJECTED", to)).toBe(false);
    }
  });

  it("lets a failed BankID sign return to the offer", () => {
    // Cancelling on the phone is not a rejection — the offer is still valid.
    expect(() => assertApplicationTransition("SIGNING", "SIGN_FAILED")).not.toThrow();
    expect(() => assertApplicationTransition("SIGN_FAILED", "OFFERED")).not.toThrow();
    expect(() => assertApplicationTransition("SIGN_FAILED", "ACCEPTED")).toThrow();
  });

  it("treats ACCEPTED as terminal for the application", () => {
    expect(isTerminalApplicationStatus("ACCEPTED")).toBe(true);
    expect(isTerminalApplicationStatus("REJECTED")).toBe(true);
    expect(isTerminalApplicationStatus("EXPIRED")).toBe(true);
    expect(isTerminalApplicationStatus("DRAFT")).toBe(false);
  });

  it("has no transition into DRAFT", () => {
    for (const from of APPLICATION_STATES) {
      expect(canTransitionApplication(from, "DRAFT")).toBe(false);
    }
  });
});

describe("loan state machine", () => {
  it("must disburse before going active", () => {
    expect(() => assertLoanTransition("DISBURSING", "ACTIVE")).not.toThrow();
    expect(() => assertLoanTransition("DISBURSING", "CLOSED")).toThrow();
  });

  it("closes only from active or default", () => {
    expect(() => assertLoanTransition("ACTIVE", "CLOSED")).not.toThrow();
    expect(() => assertLoanTransition("DEFAULTED", "CLOSED")).not.toThrow();
    expect(() => assertLoanTransition("CLOSED", "ACTIVE")).toThrow();
  });
});
