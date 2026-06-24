import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/version.ts"],
      thresholds: { lines: 90, statements: 90, branches: 85, functions: 90 },
    },
    include: ["tests/**/*.test.ts"],
    // Loads .env at the SDK root before any test runs. The SDK itself never
    // reads .env at runtime — only the test runner does, for integration tests.
    setupFiles: ["./tests/setup-env.ts"],
  },
});
