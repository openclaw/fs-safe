import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
it("keeps the public dirty reasons aligned with emitted notifications", () => {
  const compiler = path.resolve(path.dirname(require.resolve("typescript/package.json")), require("typescript/package.json").bin.tsc);
  const checked = spawnSync(process.execPath, [
    compiler, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck",
    "--module", "NodeNext", "--target", "ES2022", "test/fixtures/watch-public-api.ts",
  ], { encoding: "utf8" });
  expect(checked.error).toBeUndefined();
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
});
