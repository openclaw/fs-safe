import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { readSecureFile } from "../src/secure-file.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secure file inspection failures", () => {
  it("wraps missing-file inspection with the requested label", async () => {
    const root = await tempRoot("fs-safe-secure-missing-");
    const filePath = path.join(root, "missing");
    await expect(readSecureFile({ filePath, label: "Signing key" })).rejects.toMatchObject({
      code: "not-found",
      message: `Signing key is not readable: ${filePath}`,
    });
  });

  it("preserves non-symlink open failures", async () => {
    const root = await tempRoot("fs-safe-secure-open-failure-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const denied = Object.assign(new Error("open denied"), { code: "EACCES" });
    vi.spyOn(fs, "open").mockRejectedValueOnce(denied);
    await expect(readSecureFile({ filePath })).rejects.toBe(denied);
  });

  itPosix("classifies an ELOOP open race as a symlink refusal", async () => {
    const root = await tempRoot("fs-safe-secure-open-symlink-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("loop"), { code: "ELOOP" }));
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "symlink" });
  });

  itPosix("refuses a path swapped to a symlink after the handle opens", async () => {
    const root = await tempRoot("fs-safe-secure-path-swap-");
    const filePath = path.join(root, "secret");
    const oldPath = path.join(root, "old");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      await fs.rename(filePath, oldPath);
      await fs.symlink(oldPath, filePath);
      return handle;
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "symlink" });
  });

  it("refuses a different file swapped under an opened handle", async () => {
    const root = await tempRoot("fs-safe-secure-identity-swap-");
    const filePath = path.join(root, "secret");
    const oldPath = path.join(root, "old");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      await fs.rename(filePath, oldPath);
      await fs.writeFile(filePath, "replacement", { mode: 0o600 });
      return handle;
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("fails closed when permission inspection cannot complete", async () => {
    const root = await tempRoot("fs-safe-secure-permission-inspect-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const realLstat = fs.lstat.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error("permission inspection denied"), { code: "EACCES" });
      return await realLstat(...args);
    });
    await expect(
      readSecureFile({ filePath, inject: { platform: "win32" } }),
    ).rejects.toMatchObject({ code: "permission-unverified" });
  });

  it("times out a stalled read and closes its pinned handle", async () => {
    const root = await tempRoot("fs-safe-secure-timeout-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "readFile").mockImplementation(() => new Promise(() => undefined));
      return handle;
    });
    await expect(
      readSecureFile({ filePath, permissions: { allowInsecure: true }, io: { timeoutMs: 1 } }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects a descriptor that does not identify a regular file", async () => {
    const root = await tempRoot("fs-safe-secure-descriptor-type-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const directoryStat = await fs.stat(root);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "stat").mockResolvedValueOnce(directoryStat);
      return handle;
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "not-file" });
  });

  it("rejects a realpath identity that differs from the opened descriptor", async () => {
    const root = await tempRoot("fs-safe-secure-realpath-identity-");
    const filePath = path.join(root, "secret");
    const otherPath = path.join(root, "other");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    await fs.writeFile(otherPath, "other", { mode: 0o600 });
    const otherStat = await fs.stat(otherPath);
    const realStat = fs.stat.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      if (++calls === 1) return otherStat;
      return await realStat(...args);
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "path-mismatch" });
  });

  itPosix("rejects a descriptor reported as owned by another uid", async () => {
    const root = await tempRoot("fs-safe-secure-owner-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      const actual = await handle.stat();
      vi.spyOn(handle, "stat").mockResolvedValueOnce({
        ...actual,
        uid: (process.getuid?.() ?? actual.uid) + 1,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      } as never);
      return handle;
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "not-owned" });
  });
});
