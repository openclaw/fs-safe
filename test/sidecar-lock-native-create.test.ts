import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { tryAcquireSidecarReclaimGuard } from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

describe.skipIf(!native || process.platform === "win32")("native Root lock exclusive creation", () => {
  it("rechecks Root authority before the exclusive claim after native parent admission", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-lock-create-authority-");
    let allowed = true, nativeOpened = false;
    const failure = new Error("authority revoked before final claim");
    const lockRoot = await root(directory, { assertBeforeMutation() { if (!allowed) throw failure; } });
    const targetPath = path.join(directory, "state"), lockPath = `${targetPath}.lock`;
    const create = vi.fn(native!.createStagedFile!);
    __setNativeLoaderForTest(() => ({
      ...native!, createStagedFile: create,
      openBeneath(...args) { const fd = native!.openBeneath(...args); nativeOpened = true; return fd; },
    }));
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof lstat>) => {
      try { return Reflect.apply(lstat, fsSync, args); }
      catch (error) { if (nativeOpened && String(args[0]) === lockPath) allowed = false; throw error; }
    }) as typeof lstat);
    await expect(createSidecarLockManager(directory).acquire({
      targetPath, lockPath, lockRoot, timeoutMs: 0, staleMs: 0,
      payload: async () => ({ owner: "ours" }), shouldReclaim: () => false,
    })).rejects.toBe(failure);
    expect(nativeOpened).toBe(true);
    expect(allowed).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["lock", "guard"] as const)("preserves a competing %s created after admission", async kind => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-lock-create-race-");
    const lockRoot = await root(directory);
    const targetPath = path.join(directory, "state");
    const lockPath = `${targetPath}.lock`;
    const winnerPath = kind === "lock" ? lockPath : `${lockPath}.reclaim`;
    const create = vi.fn((parent: number, name: string) => {
      fsSync.writeFileSync(winnerPath, "foreign owner", { flag: "wx", mode: 0o600 });
      return native!.createStagedFile!(parent, name);
    });
    const rename = vi.fn(native!.renameNoReplace);
    __setNativeLoaderForTest(() => ({ ...native!, createStagedFile: create, renameNoReplace: rename }));
    if (kind === "lock") {
      const manager = createSidecarLockManager(directory);
      await expect(manager.acquire({
        targetPath, lockPath, lockRoot, timeoutMs: 0, staleMs: 0,
        payload: async () => ({ owner: "ours" }), shouldReclaim: () => false,
      })).rejects.toMatchObject({ code: "file_lock_timeout" });
      expect(manager.heldEntries()).toEqual([]);
    } else {
      await expect(tryAcquireSidecarReclaimGuard(new Set(), winnerPath, lockRoot)).resolves.toBeUndefined();
    }
    expect(create).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(winnerPath, "utf8")).toBe("foreign owner");
    expect(await fs.readdir(directory)).toEqual([path.basename(winnerPath)]);
  });

  it("removes only its incomplete direct claim after a write failure", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-lock-write-failure-");
    const lockRoot = await root(directory);
    const targetPath = path.join(directory, "state");
    const failure = Object.assign(new Error("synthetic write failure"), { code: "EIO" });
    vi.spyOn(fsSync, "write").mockImplementation(() => { throw failure; });
    const manager = createSidecarLockManager(directory);
    await expect(manager.acquire({
      targetPath, lockPath: `${targetPath}.lock`, lockRoot, timeoutMs: 0, staleMs: 0,
      payload: async () => ({ owner: "ours" }), shouldReclaim: () => false,
    })).rejects.toBeTruthy();
    expect(await fs.readdir(directory)).toEqual([]);
    expect(manager.heldEntries()).toEqual([]);
  });
});
