/**
 * Guarded state transitions.
 *
 * The only supported way to change an application's status. It validates the
 * move against the domain state machine and writes an audit event in the same
 * transaction — so an application can never change state without a record of
 * why, and an illegal move never reaches the database.
 */

import {
  assertApplicationTransition,
  assertLoanTransition,
  type ApplicationStatus,
  type LoanStatus,
} from "@refi/domain";
import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export interface TransitionInput {
  applicationId: string;
  to: ApplicationStatus;
  reason?: string;
  correlationId?: string;
  /** Guard against a stale read: only move if the row is still in this state. */
  expectedFrom?: ApplicationStatus;
}

export async function transitionApplication(
  input: TransitionInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const app = await tx.loanApplication.findUniqueOrThrow({
    where: { id: input.applicationId },
    select: { status: true, correlationId: true },
  });

  const from = app.status as ApplicationStatus;

  if (input.expectedFrom && from !== input.expectedFrom) {
    throw new Error(
      `Concurrent modification on ${input.applicationId}: expected ${input.expectedFrom}, found ${from}`,
    );
  }

  // No-op transitions are allowed to pass silently — this makes retried jobs
  // safe. Re-running a processor that already advanced the state should not
  // explode; it should simply do nothing.
  if (from === input.to) return;

  assertApplicationTransition(from, input.to);

  await tx.loanApplication.update({
    where: { id: input.applicationId },
    data: { status: input.to },
  });

  await tx.applicationEvent.create({
    data: {
      applicationId: input.applicationId,
      fromStatus: from,
      toStatus: input.to,
      reason: input.reason ?? null,
      correlationId: input.correlationId ?? app.correlationId,
    },
  });
}

export async function transitionLoan(
  loanId: string,
  to: LoanStatus,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const loan = await tx.loan.findUniqueOrThrow({
    where: { id: loanId },
    select: { status: true },
  });

  const from = loan.status as LoanStatus;
  if (from === to) return;

  assertLoanTransition(from, to);

  await tx.loan.update({
    where: { id: loanId },
    data: {
      status: to,
      ...(to === "ACTIVE" ? { disbursedAt: new Date() } : {}),
      ...(to === "CLOSED" ? { closedAt: new Date() } : {}),
    },
  });
}
