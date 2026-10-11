import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it.skipIf(Boolean(process.versions.bun))("keeps async hash admission free of metadata promise adapters", async () => {
  const directory = await tempRoot("fs-safe-hash-promises-");
  const file = path.join(directory, "input");
  await fs.writeFile(file, "hash budget");
  // Coverage and test-runner activity create unrelated promises in this process.
  const resources = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createHook } from "node:async_hooks";
    import { sha256File } from "./dist/file-hash.js";
    import { configureFsSafeNative } from "./dist/config.js";
    configureFsSafeNative({ mode: "off" });
    await sha256File(process.argv[1]);
    const resources = {};
    const hook = createHook({
      init(_id, type) { resources[type] = (resources[type] ?? 0) + 1; },
    });
    hook.enable();
    await sha256File(process.argv[1]);
    hook.disable();
    console.log(JSON.stringify(resources));
  `, file], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" })) as Record<string, number>;
  // Previously 47: all three exact metadata observations now stay synchronous.
  expect(resources.PROMISE).toBeLessThanOrEqual(35);
  expect(resources.FSREQPROMISE).toBe(3);
  expect(resources.FILEHANDLECLOSEREQ).toBe(1);
});
