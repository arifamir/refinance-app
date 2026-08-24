/**
 * Loan routes — read models.
 *
 * Note the balance is never read from a column. It is projected from the
 * ledger, so it cannot disagree with the entries that produced it.
 */

import { Hono } from "hono";
import { outstandingPrincipalMinor, prisma } from "@refi/db";
import { requireAuth, type AuthEnv } from "../auth.js";

export const loanRoutes = new Hono<AuthEnv>();

loanRoutes.use("*", requireAuth);

loanRoutes.get("/", async (c) => {
  const loans = await prisma.loan.findMany({
    where: { offer: { application: { customerId: c.get("customerId") } } },
    orderBy: { createdAt: "desc" },
    include: { offer: true },
  });
  return c.json(loans);
});

loanRoutes.get("/:id", async (c) => {
  const loan = await prisma.loan.findFirst({
    where: {
      id: c.req.param("id"),
      offer: { application: { customerId: c.get("customerId") } },
    },
    include: {
      offer: { include: { application: true } },
      schedule: { orderBy: { installmentNo: "asc" } },
      disbursements: true,
      payments: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!loan) return c.json({ error: "Not found" }, 404);

  const outstanding = await outstandingPrincipalMinor(loan.id);
  const paidInstallments = loan.schedule.filter((s) => s.status === "PAID").length;

  return c.json({
    ...loan,
    outstandingPrincipalMinor: outstanding,
    paidInstallments,
    remainingInstallments: loan.schedule.length - paidInstallments,
  });
});

/** The ledger for one loan — the audit trail, newest last. */
loanRoutes.get("/:id/ledger", async (c) => {
  const loan = await prisma.loan.findFirst({
    where: {
      id: c.req.param("id"),
      offer: { application: { customerId: c.get("customerId") } },
    },
    select: { id: true },
  });
  if (!loan) return c.json({ error: "Not found" }, 404);

  const entries = await prisma.ledgerEntry.findMany({
    where: { loanId: loan.id },
    orderBy: { createdAt: "asc" },
  });

  const debits = entries
    .filter((e) => e.direction === "DEBIT")
    .reduce((s, e) => s + e.amountMinor, 0);
  const credits = entries
    .filter((e) => e.direction === "CREDIT")
    .reduce((s, e) => s + e.amountMinor, 0);

  return c.json({
    entries,
    totals: { debits, credits, balanced: debits === credits },
  });
});
