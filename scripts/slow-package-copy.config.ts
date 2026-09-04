import { defineConfig } from "vitest/config";
import config from "../vitest.config.js";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ["test/sidecar-lock-process-exit.test.ts"],
    testNamePattern: "deduplicates listeners across manager domains and physical package copies",
    setupFiles: ["scripts/slow-package-copy.setup.ts"],
  },
});
