import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { cleanupPinnedFilePath } from "../src/replace-file-temp-owner.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

describe("pinned failure cleanup authority", () => {
  it.each(["owned", "replacement", "stale-parent", "missing-identity"])(
    "borrows the retained descriptor and handles %s",
    async (scenario) => {
      const directory = await tempRoot("fs-safe-pinned-cleanup-authority-");
      const parent = path.join(directory, "parent");
      await fs.mkdir(parent, { mode: 0o700 });
      const parentGuard = await createAsyncDirectoryGuard(parent, { bigint: true });
      if (scenario === "stale-parent") {
        await fs.rename(parent, path.join(directory, "old-parent"));
        await fs.mkdir(parent, { mode: 0o700 });
      }
      const pathname = path.join(parent, "target");
      const handle = await fs.open(pathname, "wx", 0o600);
      try {
        await handle.writeFile("owned");
        const identity = await handle.stat({ bigint: true });
        if (scenario === "replacement") {
          await fs.rename(pathname, path.join(parent, "saved"));
          await fs.writeFile(pathname, "replacement", { mode: 0o600 });
        }
        const listeners = process.listenerCount("exit");
        await cleanupPinnedFilePath({
          pathname, handle, parentGuard,
          identity: scenario === "missing-identity" ? undefined : identity,
        });
        expect(process.listenerCount("exit")).toBe(listeners);
        expect((await handle.stat({ bigint: true })).ino).toBe(identity.ino);
        if (scenario === "owned") {
          await expect(fs.lstat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(pathname, "utf8")).toBe(scenario === "replacement" ? "replacement" : "owned");
        }
      } finally {
        await handle.close();
      }
    },
  );
});

describe.each([false, true])("pinned write cleanup with mkdir=%s", (mkdir) => {
  it.each([false, true])("cleans failed writes under a large parent identity with overwrite=%s", async (overwrite) => {
    const directory = await tempRoot("fs-safe-pinned-cleanup-large-parent-");
    const target = path.join(directory, "value");
    if (overwrite) await fs.writeFile(target, "prior content");
    const parentInode = 9007199254740993n;
    const lstat = fsSync.lstatSync.bind(fsSync);
    // Real I/O and retained descriptors; only the parent's identity representation
    // models an NTFS file index that loses bits in a numeric Stats result.
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (String(args[0]) === directory) {
        stat.ino = typeof stat.ino === "bigint" ? parentInode : Number(parentInode);
      }
      return stat;
    });
    configureFsSafeNative({ mode: "off" });
    await expect(runPinnedWriteHelper({
      rootPath: directory,
      relativeParentPath: "",
      basename: "value",
      mkdir,
      mode: 0o600,
      maxBytes: 3,
      overwrite,
      input: { kind: "stream", stream: Readable.from([Buffer.from("12"), Buffer.from("34")]) },
    })).rejects.toMatchObject({ code: "too-large" });
    expect(await fs.readdir(directory)).toEqual(overwrite ? ["value"] : []);
    if (overwrite) expect(await fs.readFile(target, "utf8")).toBe("prior content");
  });
});
