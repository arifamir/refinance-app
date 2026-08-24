import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Integration tests — real Postgres + Redis, no mocks.
 *
 * These prove the guarantees that unit tests cannot: that the DATABASE actually
 * refuses a second disbursement, that a retried credit check doesn't pull the
 * bureau twice, that the flow fan-in waits for both children. The rules are
 * only as good as the schema constraints backing them, so we exercise the
 * schema.
 *
 * Isolated in the `itest` Postgres schema so they never touch dev data.
 * `global-setup.ts` creates it; each test truncates before it runs.
 */
const ITEST_DATABASE_URL =
  process.env.ITEST_DATABASE_URL ??
  "postgresql://refinance:refinance@localhost:5432/refinance?schema=itest";

export default defineConfig({
  // The root has no node_modules symlinks for workspace packages, so map the
  // @refi/* specifiers straight to their source entrypoints.
  resolve: {
    alias: {
      "@refi/domain": pkg("packages/domain/src/index.ts"),
      "@refi/db": pkg("packages/db/src/index.ts"),
      "@refi/adapters": pkg("packages/adapters/src/index.ts"),
    },
  },
  test: {
    include: ["apps/*/src/**/*.itest.ts", "packages/*/src/**/*.itest.ts", "tests/**/*.itest.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    // Shared tables — run files serially so truncation between them is safe.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL: ITEST_DATABASE_URL,
      // Deterministic, zero-latency fakes for fast, repeatable runs.
      FAKE_LATENCY_MS: "0",
      FAKE_BANKID_COLLECTS_UNTIL_COMPLETE: "1",
      FAKE_PAYMENT_TRANSIENT_FAILURES: "0",
      PII_KEY: "",
      NODE_ENV: "test",
    },
  },
});
