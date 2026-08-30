import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    // Windows hosted runners become nondeterministic when filesystem stress
    // suites compete. Other CI hosts stay bounded so high-core machines do not
    // make the stress and property suites time out under process contention.
    maxWorkers: process.platform === "win32" ? 1 : process.env.CI ? 4 : undefined,
    expect: {
      requireAssertions: true,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/types.ts",
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
