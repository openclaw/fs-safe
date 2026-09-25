import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { realpathSync } from "../src/realpath.js";
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

  it.each([
    { allowInsecure: false, failure: undefined, failClose: false },
    { allowInsecure: true, failure: undefined, failClose: false },
    { allowInsecure: false, failure: new Error("descriptor unavailable"), failClose: true },
    { allowInsecure: true, failure: new Error("descriptor unavailable"), failClose: true },
  ])("closes before a permission fd getter's microtask ($allowInsecure, $failClose)", async ({
    allowInsecure, failure, failClose,
  }) => {
    const root = await tempRoot("fs-safe-secure-permission-fd-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const events: string[] = [];
    let inspectPermissions = false;
    const realpath = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
      const resolved = realpath(...args);
      if (args[0] === root) inspectPermissions = true;
      return resolved;
    });
    const realOpen = fs.open.bind(fs);
    let opened: fs.FileHandle | undefined;
    let closeReceiver: unknown;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    let read: ReturnType<typeof vi.spyOn> | undefined;
    let readFile: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = opened = await realOpen(...args);
      const descriptor = handle.fd;
      Object.defineProperty(handle, "fd", {
        configurable: true,
        get() {
          if (inspectPermissions) {
            events.push("fd");
            queueMicrotask(() => events.push("microtask"));
            throw failure;
          }
          return descriptor;
        },
      });
      const realClose = handle.close;
      close = vi.spyOn(handle, "close").mockImplementation(function (this: fs.FileHandle) {
        closeReceiver = this;
        events.push("close");
        Reflect.deleteProperty(handle, "fd");
        return realClose.call(this).then(() => {
          if (failClose) throw new Error("close failed");
        });
      });
      read = vi.spyOn(handle, "read");
      readFile = vi.spyOn(handle, "readFile");
      return handle;
    });

    await expect(readSecureFile({
      filePath, trust: { trustedDirs: [root] }, permissions: { allowInsecure },
    })).rejects.toBe(failure);
    expect(events).toEqual(["fd", "close", "microtask"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeReceiver).toBe(opened);
    expect(opened?.fd).toBe(-1);
    expect(read).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
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

  itPosix("fails closed when simulated Windows permission inspection cannot complete", async () => {
    const root = await tempRoot("fs-safe-secure-permission-inspect-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const realLstat = fsSync.lstatSync.bind(fsSync);
    let calls = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error("permission inspection denied"), { code: "EACCES" });
      return realLstat(...args);
    });
    await expect(
      readSecureFile({ filePath, inject: { platform: "win32" } }),
    ).rejects.toMatchObject({
      code: "permission-unverified",
      category: "operational",
      message: expect.stringContaining("Error: permission inspection denied"),
    });
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
      vi.spyOn(fsSync, "fstatSync").mockReturnValueOnce(directoryStat);
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
    const realStat = fsSync.statSync.bind(fsSync);
    const changedIdentity = vi.spyOn(fsSync, "statSync").mockImplementationOnce((...args) => {
      return realStat(otherPath, args[1]);
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(changedIdentity).toHaveBeenCalledTimes(1);
  });

  itPosix("rejects a descriptor reported as owned by another uid", async () => {
    const root = await tempRoot("fs-safe-secure-owner-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      const actual = await handle.stat();
      vi.spyOn(fsSync, "fstatSync").mockReturnValueOnce({
        ...actual,
        uid: (process.geteuid?.() ?? actual.uid) + 1,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      } as never);
      return handle;
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "not-owned" });
  });

  itPosix("fails closed before reading when the descriptor owner uid is unavailable", async () => {
    const root = await tempRoot("fs-safe-secure-missing-owner-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const realOpen = fs.open.bind(fs);
    let read: ReturnType<typeof vi.spyOn>;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      read = vi.spyOn(handle, "readFile");
      const actual = await handle.stat();
      vi.spyOn(fsSync, "fstatSync").mockReturnValueOnce({
        ...actual,
        uid: undefined,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      } as never);
      return handle;
    });

    await expect(readSecureFile({ filePath })).rejects.toMatchObject({
      code: "permission-unverified",
      category: "operational",
    });
    expect(read!).not.toHaveBeenCalled();
  });

  itPosix("uses the effective uid when the real and effective identities differ", async () => {
    const root = await tempRoot("fs-safe-secure-effective-owner-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const ownerUid = fsSync.statSync(filePath).uid;
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(ownerUid + 1);
    const geteuid = vi.spyOn(process, "geteuid").mockReturnValue(ownerUid);

    const result = await readSecureFile({ filePath });
    expect(result.buffer.toString()).toBe("secret");
    expect(geteuid).toHaveBeenCalledTimes(1);
    expect(getuid).not.toHaveBeenCalled();
  });

  itPosix("rejects an owner that matches only the real uid", async () => {
    const root = await tempRoot("fs-safe-secure-real-owner-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const ownerUid = fsSync.statSync(filePath).uid;
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(ownerUid);
    vi.spyOn(process, "geteuid").mockReturnValue(ownerUid + 1);

    await expect(readSecureFile({ filePath })).rejects.toMatchObject({
      code: "not-owned",
      message: expect.stringContaining(`effective user (uid=${ownerUid + 1})`),
    });
    expect(getuid).not.toHaveBeenCalled();
  });

  itPosix("fails closed when the effective uid is unavailable", async () => {
    const root = await tempRoot("fs-safe-secure-missing-effective-owner-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const ownerUid = fsSync.statSync(filePath).uid;
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(ownerUid);
    vi.spyOn(process, "geteuid").mockReturnValue(undefined as never);

    await expect(readSecureFile({ filePath })).rejects.toMatchObject({
      code: "permission-unverified",
      category: "operational",
      message: expect.stringContaining("owner identity could not be verified"),
    });
    expect(getuid).not.toHaveBeenCalled();
  });
});
