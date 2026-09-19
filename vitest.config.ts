import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The repo's first test runner. Node environment only — these tests cover the
 * accounting engine (pure money/date arithmetic, and posting invariants
 * against the real schema), not React components.
 *
 * `setupFiles` loads .env because the integration tests need DATABASE_URL and
 * tsx/vitest do not read it the way Next's @next/env does.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Integration tests share one database and serialise on DocumentSeries
    // row locks; running files in parallel would deadlock rather than fail
    // informatively.
    fileParallelism: false,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
