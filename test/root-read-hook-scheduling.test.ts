import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest, type FsSafeTestHooks } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const hookNames = ["afterPreOpenLstat", "beforeOpen", "afterOpen"] as const;

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

async function fixture() {
  const scoped = await root(await tempRoot("fs-safe-read-hooks-"));
  const filePath = path.join(scoped.rootReal, "value");
  await fs.writeFile(filePath, "original");
  return { scoped, filePath };
}

it.each([false, true])("retains hook getters, receivers and awaited undefined (callbacks: %s)", async (callbacks) => {
  const { scoped, filePath } = await fixture();
  const hooks: FsSafeTestHooks = {};
  const reads = { afterPreOpenLstat: 0, beforeOpen: 0, afterOpen: 0 };
  const resumed = { afterPreOpenLstat: false, beforeOpen: false, afterOpen: false };
  const called: string[] = [];
  for (const name of hookNames) {
    Object.defineProperty(hooks, name, {
      get() {
        reads[name]++;
        if (name === "beforeOpen") expect(resumed.afterPreOpenLstat).toBe(true);
        if (!callbacks) {
          queueMicrotask(() => { resumed[name] = true; });
          return undefined;
        }
        return function (this: FsSafeTestHooks, candidate: string) {
          expect(this).toBe(hooks);
          expect(candidate).toBe(filePath);
          called.push(name);
          queueMicrotask(() => { resumed[name] = true; });
        };
      },
    });
  }
  const actualOpen = fs.open.bind(fs);
  const open = vi.spyOn(fs, "open").mockImplementation((...args) => {
    expect(resumed.beforeOpen).toBe(true);
    return actualOpen(...args);
  });
  const actualFstat = fsSync.fstatSync.bind(fsSync);
  const fstat = vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    expect(resumed.afterOpen).toBe(true);
    return actualFstat(...args);
  });
  __setFsSafeTestHooksForTest(hooks);

  await expect(scoped.readText("value")).resolves.toBe("original");
  expect(reads).toEqual({ afterPreOpenLstat: 1, beforeOpen: 1, afterOpen: 1 });
  expect(called).toEqual(callbacks ? [...hookNames] : []);
  expect(open).toHaveBeenCalledTimes(1);
  expect(fstat).toHaveBeenCalled();
});

it.each(hookNames)("joins a rejected %s hook and owned-handle cleanup before rejecting", async (name) => {
  const { scoped, filePath } = await fixture();
  const failure = { hook: name };
  let enterHook!: () => void;
  const hookEntered = new Promise<void>(resolve => { enterHook = resolve; });
  let rejectHook!: (reason: unknown) => void;
  const hookResult = new Promise<void>((_resolve, reject) => { rejectHook = reject; });
  let enterClose!: () => void;
  const closeEntered = new Promise<void>(resolve => { enterClose = resolve; });
  let releaseClose!: () => void;
  const closeReleased = new Promise<void>(resolve => { releaseClose = resolve; });
  let handle: FileHandle | undefined;
  let close: ReturnType<typeof vi.spyOn> | undefined;
  let read: ReturnType<typeof vi.spyOn> | undefined;
  const actualOpen = fs.open.bind(fs);
  const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    handle = await actualOpen(...args);
    const actualClose = handle.close.bind(handle);
    close = vi.spyOn(handle, "close").mockImplementation(async () => {
      enterClose();
      await closeReleased;
      await actualClose();
    });
    read = vi.spyOn(handle, "read");
    return handle;
  });
  const hooks: FsSafeTestHooks = {};
  Object.defineProperty(hooks, name, {
    value: function (this: FsSafeTestHooks, candidate: string) {
      expect(this).toBe(hooks);
      expect(candidate).toBe(filePath);
      enterHook();
      return hookResult;
    },
  });
  __setFsSafeTestHooksForTest(hooks);
  let settled = false;
  const outcome = scoped.read("value").then(
    () => { settled = true; return undefined; },
    error => { settled = true; return error; },
  );
  try {
    await hookEntered;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(open).toHaveBeenCalledTimes(name === "afterOpen" ? 1 : 0);
    rejectHook(failure);
    if (name === "afterOpen") {
      await closeEntered;
      expect(settled).toBe(false);
      expect(fsSync.fstatSync(handle!.fd).isFile()).toBe(true);
      expect(read).not.toHaveBeenCalled();
      releaseClose();
    }
    expect(await outcome).toBe(failure);
    if (handle) {
      expect(close).toHaveBeenCalledTimes(1);
      expect(handle.fd).toBe(-1);
    }
  } finally {
    rejectHook(failure);
    releaseClose();
    await outcome;
    if (handle && handle.fd >= 0) await handle.close();
  }
});
