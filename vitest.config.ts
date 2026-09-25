import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file starts its own embedded Postgres (PGlite), which is slow to boot in parallel.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
