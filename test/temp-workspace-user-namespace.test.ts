import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealTempDirs } from "./helpers/vitest.js";

const proc = vi.hoisted(() => ({ files: new Map<string, string | Error>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
        if (typeof args[0] === "string" && proc.files.has(args[0])) {
          const value = proc.files.get(args[0]);
          if (value instanceof Error) throw value;
          return value;
        }
        return actual.readFileSync(...args);
      },
    },
  };
});

const { tempRoot } = useRealTempDirs();
const exitListeners: Array<(code: number) => void> = [];
beforeEach(() => {
  vi.resetModules();
  const once = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "exit") exitListeners.push(listener);
    return once(event, listener);
  });
  proc.files.clear();
  proc.files.set("/proc/self/uid_map", "1001 1001 1\n");
  proc.files.set("/proc/self/gid_map", "1001 1001 1\n");
  proc.files.set("/proc/sys/kernel/overflowuid", "65534\n");
  proc.files.set("/proc/sys/kernel/overflowgid", "65534\n");
});
afterEach(() => {
  // Fresh module instances own fresh exit handlers; explicit workspace cleanup has settled them.
  for (const listener of exitListeners.splice(0)) process.removeListener("exit", listener);
  vi.restoreAllMocks();
});

describe.runIf(process.platform === "linux")("temp workspace user namespaces", () => {
  type Case = {
    name: string;
    map?: string | Error;
    gidMap?: string;
    nextMapping?: { kind: "uid" | "gid"; value: string };
    uid?: number;
    gid?: number;
    overflow?: [number, number];
    mode: number;
    leaf?: boolean;
    alias?: boolean;
    missing?: boolean;
    error?: string;
  };
  const cases: Case[] = [
    { name: "identity mapping", map: "0 0 4294967295", uid: 65534, gid: 65534, mode: 0o755, error: "not-owned" },
    { name: "unavailable namespace evidence", map: new Error("proc unavailable"), uid: 65534, gid: 65534, mode: 0o755, error: "not-owned" },
    { name: "mapped overflow-number owner", map: "1001 1001 1\n65534 1002 1", uid: 65534, gid: 65534, mode: 0o755, error: "not-owned" },
    { name: "identity group mapping", gidMap: "0 0 4294967295", uid: 65534, gid: 65534, mode: 0o755, error: "not-owned" },
    { name: "mapped overflow-number group", gidMap: "1001 1001 1\n65534 1002 1", uid: 65534, gid: 65534, mode: 0o755, error: "not-owned" },
    { name: "custom overflow IDs", overflow: [60001, 60002], uid: 60001, gid: 60002, mode: 0o755 },
    { name: "unmapped ancestor", uid: 65534, gid: 65534, mode: 0o755 },
    { name: "missing root below unmapped ancestor", uid: 65534, gid: 65534, mode: 0o755, missing: true },
    { name: "admits a sticky world-writable unmapped ancestor (host /tmp under PrivateUsers)", uid: 65534, gid: 65534, mode: 0o1777 },
    { name: "group-writable unmapped ancestor", uid: 65534, gid: 65534, mode: 0o775, error: "insecure-permissions" },
    { name: "world-writable unmapped ancestor", uid: 65534, gid: 65534, mode: 0o777, error: "insecure-permissions" },
    { name: "mapped foreign ancestor", map: "1001 1001 1\n1002 1002 1", uid: 1002, gid: 1002, mode: 0o755, error: "not-owned" },
    { name: "non-overflow group", uid: 65534, gid: 1002, mode: 0o755, error: "not-owned" },
    { name: "unmapped leaf", uid: 65534, gid: 65534, mode: 0o700, leaf: true, error: "not-owned" },
    { name: "aliased unmapped leaf", uid: 65534, gid: 65534, mode: 0o700, leaf: true, alias: true, error: "not-owned" },
    { name: "root-owned leaf", uid: 0, gid: 0, mode: 0o700, leaf: true, error: "not-owned" },
    { name: "foreign leaf", uid: 1002, gid: 1002, mode: 0o700, leaf: true, error: "not-owned" },
    { name: "sticky writable leaf", mode: 0o1777, leaf: true, error: "insecure-permissions" },
    ...(["uid", "gid"] as const).flatMap((kind) => [
      { name: `rejects after ${kind}_map becomes identity`, uid: 65534, gid: 65534, mode: 0o755,
        nextMapping: { kind, value: "0 0 4294967295" } },
      { name: `rejects after ${kind}_map maps the overflow ID`, uid: 65534, gid: 65534, mode: 0o755,
        nextMapping: { kind, value: "1001 1001 1\n65534 1002 1" } },
    ]),
  ];
  for (const variant of ["async", "sync"] as const) {
    it.each(cases)(`${variant}: $name`, async ({ map, gidMap, nextMapping, uid, gid, overflow, mode, leaf, alias, missing, error }) => {
      if (map) proc.files.set("/proc/self/uid_map", map);
      if (gidMap) proc.files.set("/proc/self/gid_map", gidMap);
      if (overflow) {
        proc.files.set("/proc/sys/kernel/overflowuid", String(overflow[0]));
        proc.files.set("/proc/sys/kernel/overflowgid", String(overflow[1]));
      }
      const ancestor = await tempRoot("fs-safe-user-namespace-");
      const rootDir = path.join(ancestor, "private-root");
      if (!missing) await fs.mkdir(rootDir, { mode: 0o700 });
      const requestedRoot = alias ? path.join(ancestor, "alias") : rootDir;
      if (alias) await fs.symlink(rootDir, requestedRoot, "dir");
      const selected = leaf ? rootDir : ancestor;
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (name === selected && stat) {
          if (uid !== undefined) stat.uid = typeof stat.uid === "bigint" ? BigInt(uid) : uid;
          if (gid !== undefined) stat.gid = typeof stat.gid === "bigint" ? BigInt(gid) : gid;
          stat.mode = typeof stat.mode === "bigint" ? BigInt(0o40000 | mode) : 0o40000 | mode;
        }
        return stat;
      });
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const { configureFsSafeNative } = await import("../src/native-config.js");
      configureFsSafeNative({ mode: "off" });
      const { withTempWorkspace, withTempWorkspaceSync } = await import("../src/temp.js");
      let callbacks = 0;
      const run = () => variant === "async"
        ? withTempWorkspace({ rootDir: requestedRoot, prefix: "namespace-" }, async (workspace) => {
          callbacks += 1;
          await workspace.writeText("proof", "private");
          return await workspace.read("proof");
        })
        : withTempWorkspaceSync({ rootDir: requestedRoot, prefix: "namespace-" }, (workspace) => {
          callbacks += 1;
          workspace.writeText("proof", "private");
          return workspace.read("proof");
        });
      if (error) {
        await expect(Promise.resolve().then(run)).rejects.toMatchObject({ code: error });
        expect(callbacks).toBe(0);
      } else {
        expect((await run()).toString()).toBe("private");
        if (nextMapping) {
          proc.files.set(`/proc/self/${nextMapping.kind}_map`, nextMapping.value);
          await expect(Promise.resolve().then(run)).rejects.toMatchObject({ code: "not-owned" });
          expect(callbacks).toBe(1);
        } else {
          expect((await run()).toString()).toBe("private");
          expect(callbacks).toBe(2);
        }
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("unverifiable"),
          { code: "FS_SAFE_UNMAPPED_TEMP_ANCESTOR", type: "FsSafeWarning" },
        );
      }
      expect(await fs.readdir(rootDir)).toEqual([]);
    });
  }
});
