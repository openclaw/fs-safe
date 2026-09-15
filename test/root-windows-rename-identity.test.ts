import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFileLock } from "../src/file-lock.js";
import { configureFsSafeNative, root, type RootWriteOptions } from "../src/index.js";
import * as durability from "../src/directory-durability.js";
import * as verification from "../src/root-write-verification.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const policy = "verify-content-with-lock" as const;
const methods = ["text", "buffer", "json"] as const;
type Method = typeof methods[number];
type SafeRoot = Awaited<ReturnType<typeof root>>;

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

function lockPath(directory: string, relative = "target"): string {
  const digest = createHash("sha256").update(relative).digest("hex");
  return path.join(directory, `.fs-safe-write-${digest}.lock`);
}

function bytes(method: Method): Buffer {
  if (method === "json") return Buffer.from('{"value":"payload"}\n');
  if (method === "buffer") return Buffer.from([0, 1, 127, 255]);
  return Buffer.from("caf\u00e9", "utf16le");
}

async function write(safe: SafeRoot, method: Method, options: RootWriteOptions = {}): Promise<void> {
  if (method === "json") return await safe.writeJson("target", { value: "payload" }, options);
  if (method === "buffer") return await safe.write("target", bytes(method), options);
  return await safe.write("target", "caf\u00e9", { encoding: "utf16le", ...options });
}

// Model a rename boundary with different source/destination identities using
// real files and handles. Retain the old object so fchmod can still succeed on
// its descriptor: the test must prove finalization selects the new object.
function renameWithNewIdentity(targetPath: string, replacement?: Buffer) {
  const retired = path.join(path.dirname(targetPath), "retired-stage");
  const rename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (destination !== targetPath) return await rename(source, destination);
    await rename(source, retired);
    if (replacement === undefined) await fs.copyFile(retired, destination);
    else await fs.writeFile(destination, replacement);
    expect((await fs.lstat(retired, { bigint: true })).ino)
      .not.toBe((await fs.lstat(destination, { bigint: true })).ino);
  });
}

describe.skipIf(process.platform !== "win32")("Windows Root rename identity policy", () => {
  describe.each(["off", "auto"] as const)("native %s", nativeMode => {
    beforeEach(() => configureFsSafeNative({ mode: nativeMode }));

    it.each(methods.flatMap(method => ["default", "per-call"].flatMap(setting =>
      [false, true].map(existing => ({ method, setting, existing })))))(
      "accepts $method matching bytes with $setting policy (existing=$existing)",
      async ({ method, setting, existing }) => {
        const directory = await tempRoot("fs-safe-win-rename-policy-");
        const target = path.join(directory, "target");
        if (existing) await fs.writeFile(target, "previous");
        const safe = await root(directory, setting === "default" ? { renameIdentity: policy } : {});
        const publication = renameWithNewIdentity(target);
        await expect(write(safe, method, setting === "per-call" ? { renameIdentity: policy } : {}))
          .resolves.toBeUndefined();
        expect(publication).toHaveBeenCalled();
        expect(await fs.readFile(target)).toEqual(bytes(method));
        await expect(fs.lstat(lockPath(directory))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it.each(["default", "per-call"] as const)("refuses a stale %s lock before creating parents or content", async setting => {
      const directory = await tempRoot("fs-safe-win-rename-stale-");
      const sidecar = lockPath(directory, "missing/target");
      const stale = JSON.stringify({ pid: 9_999_999, createdAt: "2000-01-01T00:00:00.000Z" });
      await fs.writeFile(sidecar, stale);
      const safe = await root(directory, setting === "default" ? { renameIdentity: policy } : {});
      const mutate = vi.fn();
      await expect(safe.write("missing/target", "payload", {
        ...(setting === "per-call" ? { renameIdentity: policy } : {}), assertBeforeMutation: mutate,
      })).rejects.toMatchObject({ code: "file_lock_stale" });
      expect(mutate).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([path.basename(sidecar)]);
      expect(await fs.readFile(sidecar, "utf8")).toBe(stale);
    });

    it("waits for an existing compatibility holder before opening the destination for mutation", async () => {
      const directory = await tempRoot("fs-safe-win-rename-contention-");
      const target = path.join(directory, "target");
      await fs.writeFile(target, "previous");
      const safe = await root(directory, { renameIdentity: policy });
      const sidecar = lockPath(directory);
      const holder = await acquireFileLock(directory, {
        managerKey: `windows-policy-holder:${directory}`, lockPath: sidecar,
        payload: () => ({ createdAt: new Date().toISOString() }),
      });
      const observed = Promise.withResolvers<void>();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === sidecar && typeof args[1] === "number" &&
          (args[1] & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0) observed.resolve();
        return handle;
      });
      const mutate = vi.fn();
      const writing = safe.write("target", "next", { assertBeforeMutation: mutate });
      try {
        await Promise.race([
          observed.promise,
          writing.then(() => { throw new Error("write completed before observing the held sidecar"); }),
        ]);
        expect(mutate).not.toHaveBeenCalled();
        expect(await fs.readFile(target, "utf8")).toBe("previous");
        await holder.release();
        await writing;
        expect(mutate).toHaveBeenCalled();
        expect(await fs.readFile(target, "utf8")).toBe("next");
      } finally {
        await holder.release();
        await writing.catch(() => undefined);
      }
    });

    it.each([Buffer.from("changed"), Buffer.alloc(128, 65)])("rejects changed publication bytes %j", async replacement => {
      const directory = await tempRoot("fs-safe-win-rename-changed-");
      const target = path.join(directory, "target");
      const safe = await root(directory, { renameIdentity: policy });
      renameWithNewIdentity(target, replacement);
      await expect(safe.write("target", "payload")).rejects.toMatchObject({ code: "path-mismatch" });
      expect(await fs.readFile(target)).toEqual(replacement);
      await expect(fs.lstat(lockPath(directory))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects a matching-content hardlink before accepting its descriptor", async () => {
      const directory = await tempRoot("fs-safe-win-rename-hardlink-");
      const target = path.join(directory, "target");
      const alias = path.join(directory, "alias");
      const safe = await root(directory, { renameIdentity: policy });
      renameWithNewIdentity(target);
      const copyFile = fs.copyFile.bind(fs);
      vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        await copyFile(...args);
        if (args[1] === target) await fs.link(target, alias);
      });
      await expect(safe.write("target", "payload")).rejects.toMatchObject({ code: "hardlink" });
      expect(await fs.readFile(alias, "utf8")).toBe("payload");
      expect((await fs.stat(target)).nlink).toBe(2);
      await expect(fs.lstat(lockPath(directory))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each([undefined, "strict"] as const)("keeps the %s policy strict on the Windows fallback", async renameIdentity => {
      // Force the existing Windows buffered fallback even if the addon is installed.
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-win-rename-strict-");
      const target = path.join(directory, "target");
      const safe = await root(directory);
      renameWithNewIdentity(target);
      await expect(safe.write("target", "payload", { renameIdentity })).rejects.toMatchObject({ code: "path-mismatch" });
      await expect(fs.lstat(lockPath(directory))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("lets per-call strict override the compatibility default without entering its lock", async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-win-rename-strict-override-");
      const target = path.join(directory, "target");
      const sidecar = lockPath(directory);
      await fs.writeFile(sidecar, "pre-existing lock sentinel");
      const safe = await root(directory, { renameIdentity: policy });
      renameWithNewIdentity(target);
      await expect(safe.write("target", "payload", { renameIdentity: "strict" }))
        .rejects.toMatchObject({ code: "path-mismatch" });
      expect(await fs.readFile(sidecar, "utf8")).toBe("pre-existing lock sentinel");
    });

    it.each([true, false])("retains the accepted descriptor and lock through finalization (durable=%s)", async durable => {
      const directory = await tempRoot("fs-safe-win-rename-pin-");
      const target = path.join(directory, "target");
      const safe = await root(directory, { renameIdentity: policy });
      renameWithNewIdentity(target);
      const open = fs.open.bind(fs);
      let accepted: FileHandle | undefined;
      const events: string[] = [];
      const assertPinned = () => {
        expect(accepted?.fd).toBeGreaterThanOrEqual(0);
        expect(fsSync.fstatSync(accepted!.fd).isFile()).toBe(true);
        expect(fsSync.existsSync(lockPath(directory))).toBe(true);
      };
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === target && typeof args[1] === "number" &&
          (args[1] & fsSync.constants.O_RDWR) !== 0) {
          accepted = handle;
          const chmod = handle.chmod.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle);
          vi.spyOn(handle, "chmod").mockImplementation(async mode => {
            assertPinned(); events.push("chmod"); await chmod(mode);
          });
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            assertPinned(); events.push("sync"); await sync();
          });
          vi.spyOn(handle, "close").mockImplementation(async () => {
            assertPinned(); events.push("close"); await close();
          });
        }
        return handle;
      });
      const verify = verification.verifyAtomicWriteResult;
      vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async params => {
        if (params.targetPath === target) {
          assertPinned();
          expect(params.fd).toBe(accepted!.fd);
          expect(params.expectedIdentity.ino).toBe(fsSync.fstatSync(accepted!.fd, { bigint: true }).ino);
          events.push("verify");
        }
        await verify(params);
      });
      const syncDirectory = durability.syncDirectoryBestEffort;
      vi.spyOn(durability, "syncDirectoryBestEffort").mockImplementation(async (...args) => {
        assertPinned(); events.push("parent-sync"); await syncDirectory(...args);
      });
      try {
        await safe.write("target", "payload", { mode: 0o400, durable });
        expect(events).toEqual(durable
          ? ["verify", "verify", "chmod", "sync", "verify", "parent-sync", "verify", "close"]
          : ["verify", "verify", "chmod", "verify", "close"]);
        expect(accepted!.fd).toBe(-1);
        expect((await fs.stat(target)).mode & 0o200).toBe(0);
        expect(await fs.readFile(target, "utf8")).toBe("payload");
      } finally {
        await fs.chmod(target, 0o600).catch(() => undefined);
      }
    });

    it("rejects a destination change during final parent sync after content acceptance", async () => {
      const directory = await tempRoot("fs-safe-win-rename-late-change-");
      const target = path.join(directory, "target");
      const safe = await root(directory, { renameIdentity: policy });
      const rename = fs.rename.bind(fs);
      renameWithNewIdentity(target);
      const syncDirectory = durability.syncDirectoryBestEffort;
      vi.spyOn(durability, "syncDirectoryBestEffort").mockImplementation(async (...args) => {
        await syncDirectory(...args);
        await rename(target, path.join(directory, "accepted"));
        await fs.writeFile(target, "later");
      });
      await expect(safe.write("target", "payload")).rejects.toMatchObject({ code: "path-mismatch" });
      expect(await fs.readFile(target, "utf8")).toBe("later");
      expect(await fs.readFile(path.join(directory, "accepted"), "utf8")).toBe("payload");
    });

    it.each([0o400, 0o440])("publishes a missing read-only target with mode %s", async mode => {
      const directory = await tempRoot("fs-safe-win-rename-readonly-");
      const target = path.join(directory, "target");
      const safe = await root(directory, { renameIdentity: policy });
      try {
        await safe.writeJson("target", { value: "payload" }, { mode });
        expect((await fs.stat(target)).mode & 0o200).toBe(0);
        expect(await fs.readFile(target)).toEqual(bytes("json"));
        expect(await fs.readdir(directory)).toEqual(["target"]);
      } finally {
        await fs.chmod(target, 0o600).catch(() => undefined);
      }
    });

    it("does not alter an existing read-only destination or leave a placeholder", async () => {
      const directory = await tempRoot("fs-safe-win-rename-existing-readonly-");
      const target = path.join(directory, "target");
      await fs.writeFile(target, "previous");
      await fs.chmod(target, 0o400);
      const safe = await root(directory, { renameIdentity: policy });
      try {
        await expect(safe.write("target", "next")).rejects.toBeDefined();
        expect(await fs.readFile(target, "utf8")).toBe("previous");
        expect((await fs.stat(target)).mode & 0o200).toBe(0);
        expect(await fs.readdir(directory)).toEqual(["target"]);
      } finally {
        await fs.chmod(target, 0o600);
      }
    });

    it("does not create missing parents when mkdir is disabled", async () => {
      const directory = await tempRoot("fs-safe-win-rename-no-mkdir-");
      const safe = await root(directory, { renameIdentity: policy });
      await expect(safe.write("missing/target", "payload", { mkdir: false })).rejects.toMatchObject({ code: "not-found" });
      expect(await fs.readdir(directory)).toEqual([]);
    });
  });
});
