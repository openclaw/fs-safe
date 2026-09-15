import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { acquireFileLockSync, createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const foreign = '{"owner":"foreign"}\n';
const retry = { retries: 2, minTimeout: 0, maxTimeout: 0 };
const denial = (pathname: string, code = "EPERM") =>
  Object.assign(new Error("synthetic open denial"), { code, syscall: "open", path: pathname });

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
});

for (const { mode, timeoutMs } of (["sync", "async", "root"] as const).flatMap((mode) =>
  [undefined, Infinity].map((timeoutMs) => ({ mode, timeoutMs })))) {
  describe(`${mode} callback error replay, timeout ${timeoutMs} (synthetic Windows/errno; real files)`, () => {
    async function fixture() {
      const directory = await tempRoot("fs-safe-error-replay-");
      const lockRoot = mode === "root" ? await root(directory) : undefined;
      const target = path.join(directory, "state"), lockPath = `${target}.lock`;
      const manager = createFileLockManager(`replay:${target}`);
      configureFsSafeNative({ mode: "off" });
      Object.defineProperty(process, "platform", { value: "win32" });
      const acquire = (file: string, options: {
        payload: () => Record<string, unknown>;
        parsePayload?: (raw: string) => unknown;
        retry?: typeof retry;
      }) => mode === "sync"
        ? acquireFileLockSync(file, { retry, timeoutMs, ...options, lockRoot })
        : manager.acquire(file, { retry, timeoutMs, ...options, lockRoot });
      const failOpen = (file: string, error: Error) => {
        if (mode === "sync") {
          const open = fs.openSync.bind(fs);
          return vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, permissions) => {
            if (candidate === file && typeof flags === "number" && !(flags & fs.constants.O_EXCL)) throw error;
            return open(candidate, flags, permissions);
          });
        }
        const open = fsp.open.bind(fsp);
        return vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
          if (args[0] === file && typeof args[1] === "number" && !(args[1] & fs.constants.O_EXCL)) throw error;
          return await open(...args);
        });
      };
      return { directory, target, lockPath, manager, acquire, failOpen };
    }

    for (const callback of ["parsePayload", "payload", "toJSON"] as const) {
      it.each(["same-path", "cross-path", "fresh"] as const)(
        `propagates ${callback} %s errors exactly once`, async (history) => {
          const { directory, target, lockPath, manager, acquire, failOpen } = await fixture();
          const previousTarget = history === "cross-path" ? path.join(directory, "previous") : target;
          const previousPath = `${previousTarget}.lock`;
          const error = denial(history === "fresh" ? lockPath : previousPath);
          if (history !== "fresh") {
            fs.writeFileSync(previousPath, foreign);
            const spy = failOpen(previousPath, error);
            await expect((async () => acquire(previousTarget, {
              payload: () => ({}), retry: { ...retry, retries: 0 },
            }))()).rejects.toBe(error);
            spy.mockRestore();
          }
          fs.writeFileSync(lockPath, foreign);
          const fail = vi.fn((): never => { throw error; });
          const payload = callback === "payload" ? fail : vi.fn(() => callback === "toJSON" ? { toJSON: fail } : {});
          const parsePayload = callback === "parsePayload" ? fail : vi.fn(JSON.parse);
          const shouldReclaim = vi.fn(() => true), shouldRemoveStaleLock = vi.fn(() => true);
          await expect((async () => acquire(target, {
            payload, parsePayload, ...{ shouldReclaim, shouldRemoveStaleLock, staleRecovery: "remove-if-unchanged" as const },
          }))()).rejects.toBe(error);
          expect(fail).toHaveBeenCalledTimes(1);
          expect(payload).toHaveBeenCalledTimes(1);
          expect(shouldReclaim).not.toHaveBeenCalled();
          expect(shouldRemoveStaleLock).not.toHaveBeenCalled();
          expect(manager.heldEntries()).toEqual([]);
          expect(fs.readFileSync(lockPath, "utf8")).toBe(foreign);
          if (history === "cross-path") expect(fs.readFileSync(previousPath, "utf8")).toBe(foreign);
        },
      );
    }

    it.each(["payload", "toJSON"])("does not interpret %s EEXIST as contention", async (callback) => {
      const { target, lockPath, acquire } = await fixture();
      fs.writeFileSync(lockPath, foreign);
      const error = denial(lockPath, "EEXIST");
      const fail = vi.fn((): never => { throw error; });
      await expect((async () => acquire(target, {
        payload: callback === "payload" ? fail : () => ({ toJSON: fail }),
      }))()).rejects.toBe(error);
      expect(fail).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(foreign);
    });

    it.each([
      { retries: 0, attempts: 1 }, { retries: 2, attempts: 3 }, { retries: 20, attempts: 9 },
    ])("classifies a reused Error from each current open ($retries retries)", async ({ retries, attempts }) => {
      const { target, lockPath, acquire, failOpen } = await fixture();
      fs.writeFileSync(lockPath, foreign);
      const error = denial(lockPath);
      const spy = failOpen(lockPath, error);
      const payload = vi.fn(() => ({})), parsePayload = vi.fn(JSON.parse);
      await expect((async () => acquire(target, { payload, parsePayload, retry: { ...retry, retries } }))())
        .rejects.toBe(error);
      expect(payload).toHaveBeenCalledTimes(attempts);
      expect(parsePayload).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(fs.readFileSync(lockPath, "utf8")).toBe(foreign);
    });
  });
}
