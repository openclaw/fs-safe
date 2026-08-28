import { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSecureFile } from "../src/secure-file.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());

function onNextOpen(callback: (handle: fs.FileHandle) => void | Promise<void>) {
  const realOpen = fs.open.bind(fs);
  return vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args);
    await callback(handle);
    return handle;
  });
}

describe("secure file exact identity", () => {
  it.each([
    { allowSymlink: false, platform: "linux" as const },
    { allowSymlink: false, platform: "win32" as const },
    { allowSymlink: true, platform: "linux" as const },
    { allowSymlink: true, platform: "win32" as const },
  ])("rejects replacement with insecure permissions allowed ($allowSymlink, $platform)", async ({ allowSymlink, platform }) => {
    const root = await tempRoot("fs-safe-secure-exact-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "original", { mode: 0o600 });
    let close: ReturnType<typeof vi.spyOn>;
    let read: ReturnType<typeof vi.spyOn>;
    const open = onNextOpen(async (handle) => {
      close = vi.spyOn(handle, "close");
      read = vi.spyOn(handle, "readFile");
      await fs.rename(filePath, path.join(root, "original"));
      await fs.writeFile(filePath, "replacement", { mode: 0o600 });
    });
    await expect(readSecureFile({
      filePath, trust: { allowSymlink }, inject: { platform }, permissions: { allowInsecure: true },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(close!).toHaveBeenCalledTimes(1);
    expect(read!).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
  });

  it("rejects a realpath replaced after pathname verification", async () => {
    const root = await tempRoot("fs-safe-secure-real-swap-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "original", { mode: 0o600 });
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args) => {
      await fs.rename(filePath, path.join(root, "original"));
      await fs.writeFile(filePath, "replacement", { mode: 0o600 });
      return await realpath(...args);
    });
    await expect(readSecureFile({ filePath, permissions: { allowInsecure: true } }))
      .rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("rejects an allowed symlink retargeted after open", async () => {
    const root = await tempRoot("fs-safe-secure-link-swap-");
    const original = path.join(root, "original");
    const replacement = path.join(root, "replacement");
    const filePath = path.join(root, "secret");
    await fs.writeFile(original, "original", { mode: 0o600 });
    await fs.writeFile(replacement, "replacement", { mode: 0o600 });
    await fs.symlink(original, filePath, "file");
    onNextOpen(async () => {
      await fs.unlink(filePath);
      await fs.symlink(replacement, filePath, "file");
    });
    await expect(readSecureFile({ filePath, trust: { allowSymlink: true }, permissions: { allowInsecure: true } }))
      .rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("preserves numeric Node Stats as the public receipt", async () => {
    const root = await tempRoot("fs-safe-secure-receipt-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    let numeric: Stats;
    onNextOpen((handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) => {
        const result = await stat(options);
        if (!options?.bigint) numeric = result as Stats;
        return result;
      });
    });
    const result = await readSecureFile({ filePath, permissions: { allowInsecure: true } });
    expect(result.stat).toBe(numeric!);
    expect(result.stat).toBeInstanceOf(Stats);
    expect(result.stat.isFile()).toBe(true);
    for (const field of ["dev", "ino", "size", "mode", "uid"] as const) {
      expect(typeof result.stat[field]).toBe("number");
    }
    expect(result.buffer.toString()).toBe("secret");
  });

  it.each(["path", "realpath"] as const)("rejects a rounded numeric collision at the %s boundary", async (boundary) => {
    const root = await tempRoot("fs-safe-secure-large-id-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const ino = 9007199254740992n;
    onNextOpen((handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) => {
        const result = await stat(options);
        result.ino = options?.bigint ? ino : Number(ino);
        return result;
      });
    });
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const result = await lstat(...args);
      const value = boundary === "path" ? ino + 1n : ino;
      result.ino = args[1]?.bigint ? value : Number(value);
      return result;
    });
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      result.ino = args[1]?.bigint ? ino + 1n : Number(ino + 1n);
      return result;
    });
    await expect(readSecureFile({ filePath, permissions: { allowInsecure: true } }))
      .rejects.toMatchObject({ code: "path-mismatch" });
  });

  it.each(["descriptor", "path", "realpath"] as const)("bounds persistent unknown %s inspection and closes without reading", async (boundary) => {
    const root = await tempRoot("fs-safe-secure-unknown-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    let inspections = 0;
    let close: ReturnType<typeof vi.spyOn>;
    let read: ReturnType<typeof vi.spyOn>;
    const open = onNextOpen((handle) => {
      close = vi.spyOn(handle, "close");
      read = vi.spyOn(handle, "readFile");
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) => {
        const result = await stat(options);
        if (boundary === "descriptor" && options?.bigint) {
          inspections++;
          result.ino = 0n;
        }
        return result;
      });
    });
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const result = await lstat(...args);
      if (boundary === "path" && args[1]?.bigint) {
        inspections++;
        result.ino = 0n;
      }
      return result;
    });
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (boundary === "realpath" && args[1]?.bigint) {
        inspections++;
        result.ino = 0n;
      }
      return result;
    });
    await expect(readSecureFile({
      filePath,
      inject: { platform: process.platform === "win32" ? "linux" : "win32" },
      permissions: { allowInsecure: true },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(inspections).toBe(process.platform === "win32" ? 2 : 1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(close!).toHaveBeenCalledTimes(1);
    expect(read!).not.toHaveBeenCalled();
  });

  it("retries a transient path identity only on the actual Windows platform", async () => {
    const root = await tempRoot("fs-safe-secure-transient-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const lstat = fs.lstat.bind(fs);
    let inspections = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const result = await lstat(...args);
      if (args[1]?.bigint && ++inspections === 1) result.ino = 0n;
      return result;
    });
    const read = readSecureFile({
      filePath,
      inject: { platform: process.platform === "win32" ? "linux" : "win32" },
      permissions: { allowInsecure: true },
    });
    if (process.platform === "win32") {
      await expect(read).resolves.toMatchObject({ buffer: Buffer.from("secret") });
      expect(inspections).toBe(2);
    } else {
      await expect(read).rejects.toMatchObject({ code: "path-mismatch" });
      expect(inspections).toBe(1);
    }
  });
});
