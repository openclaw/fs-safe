import fs from "node:fs";
import promises, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { FsSafeError } from "../src/errors.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

for (const asynchronous of [false, true]) {
  it(`retains a restoration error carrying a restored receipt (${asynchronous ? "async" : "sync"})`, async () => {
    const dir = await tempRoot("fs-safe-restore-precedence-");
    const filePath = path.join(dir, "value");
    fs.writeFileSync(filePath, "original");
    const writeError = new Error("replacement failed");
    const restoreError = new FsSafeError("helper-failed", "nested restoration failed", {
      details: { cleanup: "restored" },
    });
    let writes = 0;
    const failWrite = () => { throw ++writes === 1 ? writeError : restoreError; };
    const denied = () => { throw Object.assign(new Error("rename denied"), { code: "EPERM" }); };
    const options = {
      filePath,
      content: "replacement",
      copyFallbackOnPermissionError: true,
      copyFallbackRestore: "restore-original" as const,
      maxRestoreBytes: 64,
    };
    let failure: unknown;
    try {
      if (asynchronous) {
        await replaceFileAtomic({ ...options, fileSystem: { promises: {
          ...promises,
          rename: async () => denied(),
          open: async (candidate, flags, mode) => {
            const handle = await promises.open(candidate, flags, mode);
            if (candidate !== filePath) return handle;
            return new Proxy(handle, {
              get(target, key) {
                if (key === "write") return async () => failWrite();
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }) as FileHandle;
          },
        } } });
      } else {
        replaceFileAtomicSync({ ...options, fileSystem: {
          ...fs, renameSync: denied, writeSync: failWrite as typeof fs.writeSync,
        } });
      }
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(FsSafeError);
    expect((failure as FsSafeError).details).toEqual({ cleanup: "restore-failed" });
    const cause = (failure as Error).cause as AggregateError;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(cause.errors).toEqual([writeError, restoreError]);
    expect(writes).toBe(2);
    expect(fs.readFileSync(filePath, "utf8")).toBe("");
    expect(fs.readdirSync(dir)).toEqual(["value"]);
  });
}
