import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    expect: {
      requireAssertions: true,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/advanced.ts",
        "src/atomic.ts",
        "src/permissions-public.ts",
        "src/secret.ts",
        "src/store.ts",
        "src/temp.ts",
        "src/types.ts",
        "src/file-url.ts",
        "src/test-hooks.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 84.9,
        statements: 85,
        branches: 76,
      },
    },
  },
});
