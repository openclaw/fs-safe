import sync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
type Mode = "async" | "sync";
const codes = ["EIO", "ENOSPC", "EPERM", "EEXIST"] as const;

async function exercise(mode: Mode, code?: string, faultIndex = -1, shortWrites = false) {
  const directory = await tempRoot("atomic-fault-matrix-");
  const filePath = path.join(directory, "destination");
  await fs.writeFile(filePath, "original");
  const trace: string[] = [], closed = new Set<number>(), descriptors = new Set<number>();
  const fault = Object.assign(new Error("injected " + code), { code });
  let injected = false, committed = false, admitted = false, temp = "";
  let nextDescriptor = 0;
  const point = (label: string) => {
    trace.push(label);
    if (trace.length - 1 === faultIndex) { injected = true; throw fault; }
  };
  const role = (candidate: unknown) => String(candidate) === directory ? "parent" : String(candidate) === filePath ? "destination" : "temp";
  const openedRole = (candidate: unknown, flags: unknown) => {
    const kind = role(candidate);
    if (kind === "temp" && flags !== "wx") return "copy-source";
    return kind === "destination" && shortWrites ? "restore-destination" : kind;
  };
  let outcome: unknown;
  if (mode === "async") {
    const open: typeof fs.open = async (candidate, flags, permission) => {
      const kind = openedRole(candidate, flags); point(kind + ".open");
      const handle = await fs.open(candidate, flags, permission);
      const allocation = ++nextDescriptor; descriptors.add(allocation);
      if (kind === "temp") temp = String(candidate);
      for (const method of ["stat", "chmod", "sync", "truncate", "write"] as const) {
        const original = handle[method].bind(handle) as (...args: any[]) => Promise<any>;
        Object.defineProperty(handle, method, { value: async (...args: any[]) => {
          point(kind + "." + method);
          if (shortWrites && method === "write") args[2] = Math.min(2, args[2]);
          const value = await original(...args);
          if (kind === "temp" && method === "stat") admitted = true;
          return value;
        } });
      }
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed.add(allocation); point(kind + ".close"); };
      return handle;
    };
    try {
      await replaceFileAtomic({ filePath, content: "replacement payload", syncTempFile: true, syncParentDir: true,
        copyFallbackOnPermissionError: shortWrites, copyFallbackRestore: shortWrites ? "restore-original" : "none", maxRestoreBytes: 1024, throwOnCleanupError: shortWrites,
        fileSystem: { promises: { ...fs, open,
          mkdir: (async (...args) => { point("parent.mkdir"); return fs.mkdir(...args); }) as typeof fs.mkdir,
          lstat: (async (...args) => { point(role(args[0]) + ".lstat"); return fs.lstat(...args); }) as typeof fs.lstat,
          writeFile: async (...args) => { point("temp.writeFile"); await fs.writeFile(...args); },
          rename: async (...args) => { point("rename"); if (shortWrites) throw Object.assign(new Error("fallback"), { code: "EPERM" }); await fs.rename(...args); committed = true; },
          unlink: async (...args) => { point("temp.unlink"); await fs.unlink(...args); },
        } },
      });
    } catch (error) { outcome = error; }
  } else {
    const roles = new Map<number, string>();
    const allocations = new Map<number, number>();
    const io = { ...sync };
    io.openSync = (candidate, flags, permission) => {
      const kind = openedRole(candidate, flags); point(kind + ".open");
      const fd = sync.openSync(candidate, flags, permission); roles.set(fd, kind);
      const allocation = ++nextDescriptor; allocations.set(fd, allocation); descriptors.add(allocation);
      if (kind === "temp") temp = String(candidate);
      return fd;
    };
    io.mkdirSync = ((...args) => { point("parent.mkdir"); return sync.mkdirSync(...args); }) as typeof sync.mkdirSync;
    io.lstatSync = ((...args) => { point(role(args[0]) + ".lstat"); return sync.lstatSync(...args); }) as typeof sync.lstatSync;
    io.fstatSync = ((...args) => {
      point(roles.get(args[0]) + ".stat"); const value = sync.fstatSync(...args);
      if (roles.get(args[0]) === "temp") admitted = true;
      return value;
    }) as typeof sync.fstatSync;
    io.fchmodSync = (...args) => { point(roles.get(args[0]) + ".chmod"); sync.fchmodSync(...args); };
    io.fsyncSync = (...args) => { point(roles.get(args[0]) + ".sync"); sync.fsyncSync(...args); };
    io.closeSync = fd => { sync.closeSync(fd); closed.add(allocations.get(fd)!); point(roles.get(fd) + ".close"); };
    io.writeFileSync = (...args) => { point("temp.writeFile"); sync.writeFileSync(...args); };
    io.writeSync = ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      point(roles.get(fd) + ".write"); return sync.writeSync(fd, buffer, offset, shortWrites ? Math.min(2, length) : length, position);
    }) as typeof sync.writeSync;
    io.renameSync = (...args) => { point("rename"); if (shortWrites) throw Object.assign(new Error("fallback"), { code: "EPERM" }); sync.renameSync(...args); committed = true; };
    io.unlinkSync = (...args) => { point("temp.unlink"); sync.unlinkSync(...args); };
    try { replaceFileAtomicSync({ filePath, content: "replacement payload", syncTempFile: true, syncParentDir: true,
      copyFallbackOnPermissionError: shortWrites, copyFallbackRestore: shortWrites ? "restore-original" : "none", maxRestoreBytes: 1024, throwOnCleanupError: shortWrites, fileSystem: io }); }
    catch (error) { outcome = error; }
  }
  return { directory, trace, outcome, fault, injected, committed, admitted, temp, descriptors, closed,
    entries: await fs.readdir(directory), content: await fs.readFile(filePath, "utf8") };
}

describe.each(["async", "sync"] as const)("atomic fault matrix (%s)", mode => {
  it.each(codes)("injects %s at every publication step", async code => {
    const baseline = await exercise(mode);
    expect(baseline.outcome).toBeUndefined();
    for (let index = 0; index < baseline.trace.length; index++) {
      const result = await exercise(mode, code, index);
      const step = baseline.trace[index]!;
      expect(result.injected, step).toBe(true);
      const bestEffort = step === "parent.sync" || (step === "parent.open" && baseline.trace.slice(0, index).includes("rename")) ||
        (step === "parent.close" && baseline.trace.slice(0, index).includes("rename")) || (step === "temp.sync" && code === "EPERM");
      expect(result.outcome, step).toBe(bestEffort ? undefined : result.fault);
      expect(result.content, step).toBe(result.committed ? "replacement payload" : "original");
      expect([...result.descriptors].every(fd => result.closed.has(fd)), step).toBe(true);
      // If the first descriptor stat fails, there is deliberately no identity
      // authorizing pathname cleanup. Every admitted temp must be removed.
      const unadmitted = result.temp && !result.admitted;
      expect(result.entries, step).toEqual(unadmitted ? [path.basename(result.temp), "destination"].sort() : ["destination"]);
    }
  }, 30_000);
  it("finishes short writes through the copy fallback and removes its temp", async () => {
    const result = await exercise(mode, undefined, -1, true);
    expect(result.outcome).toBeUndefined();
    expect(result.content).toBe("replacement payload");
    expect(result.trace.filter(step => step === "restore-destination.write").length).toBeGreaterThan(1);
    expect(result.entries).toEqual(["destination"]);
  });
  it.each(codes)("injects %s through copy fallback, restoration, and cleanup", async code => {
    const baseline = await exercise(mode, undefined, -1, true);
    expect(baseline.outcome).toBeUndefined();
    const contains = (error: unknown, fault: unknown): boolean => error === fault ||
      (error instanceof Error && (contains(error.cause, fault) || (error instanceof AggregateError && error.errors.some(value => contains(value, fault)))));
    for (let index = 0; index < baseline.trace.length; index++) {
      const result = await exercise(mode, code, index, true);
      const step = baseline.trace[index]!;
      expect(result.injected, step).toBe(true);
      if (result.outcome !== undefined) expect(contains(result.outcome, result.fault), step).toBe(true);
      else {
        // Documented retry and best-effort boundaries are the only places a
        // fault may settle successfully. The copy source and existing restore
        // destination retain their documented best-effort close contracts.
        const accepted = (step === "rename" && ["EPERM", "EEXIST"].includes(code)) ||
          (step === "temp.sync" && code === "EPERM") || step === "parent.sync" ||
          (step.startsWith("parent.") && baseline.trace.slice(0, index).includes("rename")) ||
          step === "restore-destination.close" || step === "copy-source.close";
        expect(accepted, `unexpectedly swallowed ${step}`).toBe(true);
      }
      expect(["original", "replacement payload"], step).toContain(result.content);
      expect([...result.descriptors].every(fd => result.closed.has(fd)), step).toBe(true);
      // A refused unlink remains registered with its exact identity. A later
      // authorized cleanup can finish; an unadmitted temp must still be retained.
      __cleanupRegisteredTempPathsForTest();
      const unadmitted = result.temp && !result.admitted;
      expect(await fs.readdir(result.directory), step).toEqual(unadmitted ? [path.basename(result.temp), "destination"].sort() : ["destination"]);
    }
  }, 60_000);
});
