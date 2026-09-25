import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file starts its own embedded Postgres (PGlite), which is slow to boot in parallel.
    testTimeout: 60000,
    hookTimeout: 60000,
    // Compiling PGlite's WebAssembly takes a lot of memory; more than two at once can crash an
    // 8 GB machine ("Fatal process out of memory: Zone"). Raise VITEST_MAX_WORKERS on bigger ones.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS) || 2,
  },
});
