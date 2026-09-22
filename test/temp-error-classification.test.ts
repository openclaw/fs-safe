import fsSync from "node:fs";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSecureTempRoot } from "../src/secure-temp-dir.js";
import { tempFile } from "../src/temp-target.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function failureCase(kind: string) {
  const events: string[] = [];
  const failure = new Error("errno observation failed");
  const getter = () => {
    events.push("get:code");
    if (kind === "throwing-getter") throw failure;
    return events.length === 1 ? "ENOENT" : "EACCES";
  };
  if (kind === "inherited-getter" || kind === "throwing-getter") {
    return { error: Object.create(Object.defineProperty({}, "code", { get: getter })), events, failure };
  }
  if (kind === "function") {
    return { error: Object.defineProperty(() => undefined, "code", { get: getter }), events, failure };
  }
  if (kind === "uncoerced-code") {
    return { error: { code: { toString() { events.push("coerce"); return "ENOENT"; } } }, events, failure };
  }
  return {
    error: new Proxy({}, {
      has(_target, key) {
        events.push(`has:${String(key)}`);
        if (kind === "throwing-has") throw failure;
        return kind !== "absent-proxy";
      },
      get(_target, key) { events.push(`get:${String(key)}`); return "ENOENT"; },
    }),
    events,
    failure,
  };
}

const cases = [
  { kind: "inherited-getter", missing: true, events: ["get:code"] },
  { kind: "present-proxy", missing: true, events: ["has:code", "get:code"] },
  { kind: "absent-proxy", missing: false, events: ["has:code"] },
  { kind: "function", missing: false, events: [] },
  { kind: "uncoerced-code", missing: false, events: [] },
  { kind: "throwing-has", throws: true, events: ["has:code"] },
  { kind: "throwing-getter", throws: true, events: ["get:code"] },
];

describe("temp errno observations", () => {
  it.each(cases)("preserves preferred-root admission for $kind", (testCase) => {
    const { error, events, failure } = failureCase(testCase.kind);
    const preferredDir = "C:\\Temp\\preferred";
    const mkdirSync = vi.fn();
    let observed = false;
    const resolve = () => resolveSecureTempRoot({
      platform: "win32",
      preferredDir,
      fallbackPrefix: "fallback",
      getuid: () => undefined,
      tmpdir: () => "C:\\Temp",
      accessSync: vi.fn(),
      mkdirSync,
      lstatSync: (pathname) => {
        if (pathname === preferredDir && !observed) {
          observed = true;
          throw error;
        }
        return { isDirectory: () => true, isSymbolicLink: () => false };
      },
    });
    if (testCase.throws) {
      let caught: unknown;
      try { resolve(); } catch (error) { caught = error; }
      expect(caught).toBe(failure);
    }
    else {
      expect(resolve()).toBe(testCase.missing ? preferredDir : "C:\\Temp\\fallback");
      expect(mkdirSync).toHaveBeenCalledTimes(testCase.missing ? 1 : 0);
    }
    expect(events).toEqual(testCase.events);
  });

  it.each(cases)("preserves compatible cleanup for $kind", async (testCase) => {
    const { error, events, failure } = failureCase(testCase.kind);
    const rootDir = await tempRoot("fs-safe-temp-errno-");
    const onCleanupError = vi.fn();
    const target = await tempFile({ rootDir, prefix: "entry", onCleanupError });
    const lstatSync = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((pathname, ...args) => {
      if (pathname === target.dir) throw error;
      return lstatSync(pathname, ...args);
    }) as typeof fsSync.lstatSync);
    const remove = vi.spyOn(fs, "rm");
    if (testCase.throws) await expect(target.cleanup()).rejects.toBe(failure);
    else {
      await expect(target.cleanup()).resolves.toBeUndefined();
      if (testCase.missing) expect(onCleanupError).not.toHaveBeenCalled();
      else {
        expect(onCleanupError).toHaveBeenCalledTimes(1);
        expect(onCleanupError.mock.calls[0]?.[0]).toBe(error);
      }
    }
    expect(events).toEqual(testCase.events);
    expect(remove).not.toHaveBeenCalled();
    expect((await fs.lstat(target.dir)).isDirectory()).toBe(true);
  });
});
