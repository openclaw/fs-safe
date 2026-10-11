import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHook } from "node:async_hooks";
import { expect, it } from "vitest";
import { assertCopySourceCurrent } from "../src/copy-file-input.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("checks copy source identity without allocating promises", async () => {
  const directory = await tempRoot("fs-safe-copy-fence-budget-");
  const realPath = path.join(directory, "source");
  await fs.writeFile(realPath, "copy source");
  const handle = await fs.open(realPath, "r");
  try {
    const identity = fsSync.fstatSync(handle.fd, { bigint: true });
    let promises = 0;
    const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
    hook.enable();
    try {
      assertCopySourceCurrent({ handle, realPath }, identity);
    } finally {
      hook.disable();
    }
    expect(promises).toBe(0);
  } finally {
    await handle.close();
  }
});
