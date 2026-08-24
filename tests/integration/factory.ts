/**
 * Test data factory.
 *
 * Builds applications at a chosen point in the lifecycle so each test can start
 * from exactly the state it exercises, without walking the whole flow.
 */

import { encryptPii, hashPersonalNumberForTest, prisma } from "./db.js";

let seq = 0;

/** A fresh, valid Swedish personal number per call, so upserts don't collide. */
export function personalNumber(): string {
  seq += 1;
  return `1990010${String(seq).padStart(5, "0")}`.slice(0, 12).padEnd(12, "0");
}

export async function makeCustomer(pn = personalNumber()) {
  return prisma.customer.create({
    data: {
      personalNumberHash: hashPersonalNumberForTest(pn),
      personalNumberEnc: encryptPii(pn),
      displayName: "Test Testsson",
      email: "test@example.com",
      phone: "+46700000000",
    },
  });
}

export interface AppOptions {
  status?: string;
  existingBalanceMinor?: number | null;
  existingAprBps?: number | null;
  existingLender?: string | null;
  /** Provide a full, passing KALP set unless overridden. */
  kalp?: Partial<{
    ownsAccommodation: boolean;
    hasSpouse: boolean;
    numberOfChildren: number;
    monthlyIncomeGrossMinor: number;
    incomeSource: string;
    monthlyDebtPaymentMinor: number;
  }> | null;
}

/** An application seeded to a given lifecycle point. */
export async function makeApplication(opts: AppOptions = {}) {
  const customer = await makeCustomer();

  const kalp =
    opts.kalp === null
      ? {}
      : {
          ownsAccommodation: false,
          hasSpouse: false,
          numberOfChildren: 0,
          monthlyIncomeGrossMinor: 4_500_000, // 45 000 kr — comfortably affordable
          incomeSource: "PERMANENT_EMPLOYMENT",
          monthlyDebtPaymentMinor: 200_000,
          ...opts.kalp,
        };

  return prisma.loanApplication.create({
    data: {
      customerId: customer.id,
      status: opts.status ?? "DRAFT",
      requestedTermMonths: 48,
      correlationId: `itest-${Date.now()}-${seq}`,
      existingBalanceMinor: opts.existingBalanceMinor ?? null,
      existingAprBps: opts.existingAprBps ?? null,
      existingLender: opts.existingLender ?? null,
      ...kalp,
    },
    include: { customer: true },
  });
}

/** A minimal BullMQ Job stand-in — enough for a processor to run. */
export function fakeJob<T>(data: T, attemptsMade = 0): any {
  return {
    data,
    attemptsMade,
    id: `job-${++seq}`,
    opts: { attempts: 5 },
  };
}
