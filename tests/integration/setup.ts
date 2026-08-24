import { beforeEach } from "vitest";
import { prisma } from "@refi/db";

/**
 * Truncate every table before each test so cases can't leak into one another.
 *
 * TRUNCATE ... CASCADE in one statement is faster than per-table deletes and
 * resets the whole graph regardless of FK order. RESTART IDENTITY keeps any
 * sequences clean.
 */
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      itest.outbox_events,
      itest.ledger_entries,
      itest.payments,
      itest.repayment_schedule,
      itest.disbursements,
      itest.loans,
      itest.offers,
      itest.credit_decisions,
      itest.kyc_checks,
      itest.statement_uploads,
      itest.application_events,
      itest.bankid_orders,
      itest.sessions,
      itest.loan_applications,
      itest.customers
    RESTART IDENTITY CASCADE
  `);
});
