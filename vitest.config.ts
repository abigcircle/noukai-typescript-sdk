import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Type-only files (interfaces/type aliases, no runtime) compile to nothing
      // and report 0% — exclude them so coverage reflects executable code only.
      exclude: ["src/index.ts", "src/version.ts", "src/types/**"],
      // Branches reflects unit-test coverage only; several relay/replay error
      // branches are exercised by the (CI-skipped) integration suite, so the
      // unit-only branch figure (~78%) sits below lines/statements/functions.
      // Set to the achieved reality with a small buffer; ratchet up over time.
      thresholds: { lines: 90, statements: 90, branches: 75, functions: 90 },
    },
    include: ["tests/**/*.test.ts"],
    // Loads .env at the SDK root before any test runs. The SDK itself never
    // reads .env at runtime — only the test runner does, for integration tests.
    setupFiles: ["./tests/setup-env.ts"],
  },
});
