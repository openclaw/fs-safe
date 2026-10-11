import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

describe("fallback mode-failure cleanup ownership", () => {
  it.each([
    { operation: "write", write: writeSecretFileAtomic },
    { operation: "create", write: createSecretFileAtomic },
  ])("$operation preserves a replacement after final chmod fails", async ({ write, operation }) => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-fallback-mode-cleanup-");
    const filePath = path.join(rootDir, "target");
    const saved = path.join(rootDir, "original");
    const failure = Object.assign(new Error("synthetic mode failure"), { code: "EIO" });
    const open = fs.open.bind(fs);
    const files = new Map<number, string>();
    let replacedPath: string | undefined;
    const failFinalMode = (fd: number) => {
      const openedPath = files.get(fd);
      if (!openedPath || fsSync.fstatSync(fd).size === 0) return;
      replacedPath = openedPath;
      fsSync.renameSync(replacedPath, saved);
      fsSync.writeFileSync(replacedPath, "replacement", { mode: 0o600 });
      throw failure;
    };
    const fchmod = fsSync.fchmodSync.bind(fsSync);
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
      failFinalMode(fd);
      fchmod(fd, mode);
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!(await handle.stat()).isFile()) return handle;
      files.set(handle.fd, String(args[0]));
      const chmod = handle.chmod.bind(handle);
      vi.spyOn(handle, "chmod").mockImplementation(async (mode) => {
        failFinalMode(handle.fd);
        await chmod(mode);
      });
      return handle;
    });

    await expect(write({ rootDir, filePath, content: "owned bytes", mode: 0o600 })).rejects.toBe(failure);

    expect(replacedPath).toBeDefined();
    expect(await fs.readFile(replacedPath!, "utf8")).toBe("replacement");
    expect(await fs.readFile(saved, "utf8")).toBe("owned bytes");
    if (operation === "write") await expect(fs.lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
