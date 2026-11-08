import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../src/native.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const exec = promisify(execFile);

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  vi.restoreAllMocks();
});

describe("raw asynchronous sidecar fallback modes", () => {
  it.each(["off", "auto-unavailable"] as const)(
    "passes 0o600 to the exclusive open and preserves the lifecycle in %s mode",
    async (scenario) => {
      const unavailable = vi.fn(() => {
        throw Object.assign(new Error("native binding unavailable"), { code: "MODULE_NOT_FOUND" });
      });
      __setNativeLoaderForTest(unavailable);
      configureFsSafeNative({ mode: scenario === "off" ? "off" : "auto" });
      const directory = await tempRoot("fs-safe-sidecar-fallback-mode-");
      const targetPath = path.join(directory, "state.json");
      const lockPath = `${targetPath}.lock`;
      const open = vi.spyOn(fs, "open");
      const manager = createSidecarLockManager(
        `fallback-mode:${scenario}:${Date.now()}:${Math.random()}`,
      );

      const lock = await manager.acquire({ targetPath, payload: () => ({ owner: scenario }) });
      try {
        expect(open).toHaveBeenCalledWith(lockPath, "wx", 0o600);
        expect((await fs.lstat(lockPath)).isFile()).toBe(true);
        await expect(lock.verifyStillHeld()).resolves.toBe(true);
      } finally {
        await lock.release();
        await manager.drain();
      }

      await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (scenario === "off") expect(unavailable).not.toHaveBeenCalled();
      else expect(unavailable).toHaveBeenCalledOnce();
    },
  );

  it("keeps require mode fail closed when the native binding is unavailable", async () => {
    const loadFailure = Object.assign(new Error("native binding unavailable"), {
      code: "MODULE_NOT_FOUND",
    });
    const unavailable = vi.fn(() => { throw loadFailure; });
    __setNativeLoaderForTest(unavailable);
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-sidecar-require-mode-");
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    const open = vi.spyOn(fs, "open");
    const manager = createSidecarLockManager(`require-mode:${Date.now()}:${Math.random()}`);

    await expect(manager.acquire({ targetPath, payload: () => ({ owner: "caller" }) }))
      .rejects.toMatchObject({ code: "helper-unavailable", cause: loadFailure });
    expect(unavailable).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.heldEntries()).toEqual([]);
  });

  itPosix.each([0o000, 0o002, 0o022, 0o077])(
    "creates an exact 0o600 sidecar in an isolated process with umask %s",
    async (umask) => {
      const directory = await tempRoot("fs-safe-sidecar-umask-");
      const child = fileURLToPath(
        new URL("./fixtures/sidecar-lock-fallback-mode-child.mjs", import.meta.url),
      );
      const { stdout, stderr } = await exec(
        process.execPath,
        ["--unhandled-rejections=strict", child, directory, String(umask)],
        { cwd: new URL("..", import.meta.url), timeout: 5_000, killSignal: "SIGKILL" },
      );

      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ mode: 0o600, held: true, absent: true });
    },
  );
});
