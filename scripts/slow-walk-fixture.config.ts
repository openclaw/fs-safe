import { defineConfig } from "vitest/config";
import config from "../vitest.config.js";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ["test/root-walk-budget.test.ts"],
    testNamePattern: "lets event-loop cancellation interrupt a complete budgeted scan before the unused suffix",
    setupFiles: ["scripts/slow-walk-fixture.setup.ts"],
  },
});
