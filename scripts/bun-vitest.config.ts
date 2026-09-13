import config from "../vitest.config.js";

if (!process.versions.bun) throw new Error("Bun tests must run under Bun");
console.log(`Bun runtime: ${process.versions.bun} (${process.platform}-${process.arch})`);

export default {
  ...config,
  test: {
    ...config.test,
    setupFiles: ["scripts/bun-vitest.setup.ts"],
  },
};
