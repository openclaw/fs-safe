import fs from "node:fs/promises";
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
    let replacedPath: string | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!(await handle.stat()).isFile()) return handle;
      vi.spyOn(handle, "chmod").mockImplementationOnce(async () => {
        replacedPath = String(args[0]);
        await fs.rename(replacedPath, saved);
        await fs.writeFile(replacedPath, "replacement", { mode: 0o600 });
        throw failure;
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
