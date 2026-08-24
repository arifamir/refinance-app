import { execSync } from "node:child_process";

/**
 * Push the Prisma schema into the isolated `itest` schema once, before any
 * integration test runs. Uses the same `prisma db push` the dev flow uses, so
 * the test database can never drift from what the app expects.
 */
export default function setup() {
  const url =
    process.env.ITEST_DATABASE_URL ??
    "postgresql://refinance:refinance@localhost:5432/refinance?schema=itest";

  execSync("prisma db push --schema packages/db/prisma/schema.prisma --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
