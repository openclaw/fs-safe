import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import {
  copyFallbackReplace,
  copyFallbackReplaceSync,
} from "../src/replace-file-copy-fallback.js";

const { tempRoot } = useTempDirs();

function bindHandle(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileHandle];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("copy fallback cleanup failures", () => {
  it("does not let close receipt failures overturn an explicitly synchronized copy", async () => {
    const root = await tempRoot("fs-safe-copy-cleanup-");
    const asyncSource = path.join(root, "async-source");
    const asyncDest = path.join(root, "async-dest");
    await fs.writeFile(asyncSource, "async");
    const asyncFs = {
      ...fs,
      async open(...args: Parameters<typeof fs.open>) {
        const handle = await fs.open(...args);
        return bindHandle(handle, {
          async close() {
            await handle.close();
            throw new Error("close receipt lost");
          },
        });
      },
    };
    await expect(copyFallbackReplace({
      fsModule: asyncFs,
      src: asyncSource,
      dest: asyncDest,
      restore: "none",
      sync: true,
    })).resolves.toBeUndefined();
    await expect(fs.readFile(asyncDest, "utf8")).resolves.toBe("async");

    const syncSource = path.join(root, "sync-source");
    const syncDest = path.join(root, "sync-dest");
    await fs.writeFile(syncSource, "sync");
    const syncModule = {
      ...fsSync,
      closeSync(fd: number) {
        fsSync.closeSync(fd);
        throw new Error("close receipt lost");
      },
    };
    expect(copyFallbackReplaceSync({
      fsModule: syncModule,
      src: syncSource,
      dest: syncDest,
      restore: "none",
      sync: true,
    })).toBeUndefined();
    expect(fsSync.readFileSync(syncDest, "utf8")).toBe("sync");
  });

  it("propagates unexpected destination inspection failures and preserves the source", async () => {
    const root = await tempRoot("fs-safe-copy-dest-error-");
    const asyncSource = path.join(root, "async-source");
    const syncSource = path.join(root, "sync-source");
    const dest = path.join(root, "dest");
    await fs.writeFile(asyncSource, "async");
    await fs.writeFile(syncSource, "sync");
    const denied = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    const asyncFs = {
      ...fs,
      async lstat(candidate: fs.PathLike, options?: fsSync.StatOptions) {
        if (String(candidate) === dest) throw denied;
        return await fs.lstat(candidate, options);
      },
    };
    await expect(copyFallbackReplace({
      fsModule: asyncFs,
      src: asyncSource,
      dest,
      restore: "none",
      sync: false,
    })).rejects.toBe(denied);
    await expect(fs.readFile(asyncSource, "utf8")).resolves.toBe("async");

    const syncModule = {
      ...fsSync,
      lstatSync(candidate: fsSync.PathLike, options?: fsSync.StatOptions) {
        if (String(candidate) === dest) throw denied;
        return fsSync.lstatSync(candidate, options);
      },
    };
    expect(() => copyFallbackReplaceSync({
      fsModule: syncModule,
      src: syncSource,
      dest,
      restore: "none",
      sync: false,
    })).toThrow(denied);
    await expect(fs.readFile(syncSource, "utf8")).resolves.toBe("sync");
  });
});
