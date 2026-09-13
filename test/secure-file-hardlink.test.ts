import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSecureFile } from "../src/secure-file.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

function onNextOpen(callback: (handle: fs.FileHandle) => void | Promise<void>) {
  const realOpen = fs.open.bind(fs);
  return vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args);
    await callback(handle);
    return handle;
  });
}

describe("secure file hardlink rejection", () => {
  it("rejects an outside inode hardlinked into a trusted directory before reading", async () => {
    const base = await tempRoot("fs-safe-secure-hardlink-");
    const trustedDir = path.join(base, "trusted");
    const outsidePath = path.join(base, "outside-secret");
    const aliasPath = path.join(trustedDir, "credential");
    await fs.mkdir(trustedDir);
    await fs.writeFile(outsidePath, "outside bytes", { mode: 0o600 });
    await fs.link(outsidePath, aliasPath);
    let read: ReturnType<typeof vi.spyOn>;
    onNextOpen((handle) => {
      read = vi.spyOn(handle, "readFile");
    });

    await expect(readSecureFile({
      filePath: aliasPath,
      trust: { trustedDirs: [trustedDir] },
      permissions: { allowInsecure: true },
    })).rejects.toMatchObject({ code: "hardlink" });
    expect(read!).not.toHaveBeenCalled();
  });

  it("rejects a hardlink introduced after reading but before bytes are returned", async () => {
    const base = await tempRoot("fs-safe-secure-late-hardlink-");
    const trustedDir = path.join(base, "trusted");
    const filePath = path.join(trustedDir, "credential");
    const outsideAlias = path.join(base, "late-alias");
    await fs.mkdir(trustedDir);
    await fs.writeFile(filePath, "secret bytes", { mode: 0o600 });
    let close: ReturnType<typeof vi.spyOn>;
    let read: ReturnType<typeof vi.spyOn>;
    onNextOpen((handle) => {
      close = vi.spyOn(handle, "close");
      const readFile = handle.readFile.bind(handle);
      read = vi.spyOn(handle, "readFile").mockImplementationOnce(async () => {
        const buffer = await readFile();
        await fs.link(filePath, outsideAlias);
        return buffer;
      });
    });

    await expect(readSecureFile({
      filePath,
      trust: { trustedDirs: [trustedDir] },
      permissions: { allowInsecure: true },
    })).rejects.toMatchObject({ code: "hardlink" });
    expect(read!).toHaveBeenCalledTimes(1);
    expect(close!).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(outsideAlias, "utf8")).resolves.toBe("secret bytes");
  });
});
