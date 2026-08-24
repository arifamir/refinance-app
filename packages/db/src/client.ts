import { PrismaClient } from "@prisma/client";

/**
 * The Prisma client instance.
 *
 * Kept in its own module so `ledger.ts` and `transitions.ts` can import it
 * without a cycle back through `index.ts`.
 *
 * One client per process: in dev, tsx reloads would otherwise leak a
 * connection pool on every save until Postgres refuses new connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === "true" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
