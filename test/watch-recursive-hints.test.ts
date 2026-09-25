import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { rootHandleContext } from "../src/root-handle-context.js";
import { scanWatch, watchScopes } from "../src/watch-scan.js";
import { admittedNativeChanges } from "../src/watch-alias.js";

it("does not publish recursive descendants of an entry-only directory", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-recursive-"));
  try {
    await fs.mkdir(path.join(temporary, "rejected-include"));
    await fs.writeFile(path.join(temporary, "rejected-include/child"), "unselected");
    const admitted = rootHandleContext(await root(temporary));
    const scopes = watchScopes([{ path: "rejected-include", kind: "entry" }]);
    const signal = new AbortController().signal;
    const snapshot = await scanWatch(admitted, scopes, { maxEntries: 10, maxDirectories: 10 }, signal, async () => {});
    expect(snapshot.directories.size).toBe(1);
    expect(await admittedNativeChanges(admitted, scopes, snapshot, snapshot, {
      overflow: false, hints: [{ directory: "rejected-include", name: "child", event: "change" }],
    }, signal, 10)).toEqual([]);
    expect(await admittedNativeChanges(admitted, scopes, snapshot, snapshot, {
      overflow: false, hints: [{ directory: "", name: "rejected-include", event: "rename" }],
    }, signal, 10)).toEqual([{ path: "rejected-include", type: "structural" }]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
