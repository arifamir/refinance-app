import { defineConfig } from "vitest/config";

/**
 * Unit tests only — pure domain logic and adapter fakes. No Postgres, no
 * Redis, no network. That is deliberate: these must run in under a second
 * from a cold checkout, so there is never a reason to skip them.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
});
