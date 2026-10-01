import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function releaseDescriptors(live: Set<number>): void {
  for (const fd of live) {
    live.delete(fd);
    try { fs.closeSync(fd); } catch { /* Preserve a failed test's original assertion. */ }
  }
}

it.each(["rename", "refusal", "copy-fallback"] as const)(
  "ignores sync void return values and preserves receivers during %s", async route => {
    const directory = await tempRoot("fs-safe-atomic-sync-void-");
    const filePath = path.join(directory, "target");
    fs.writeFileSync(filePath, "original", { mode: 0o600 });
    let thenReads = 0;
    const counts = { writes: 0, chmods: 0, closes: 0 };
    const live = new Set<number>();
    const ignored = Object.defineProperty({}, "then", {
      get() {
        thenReads++;
        throw new Error("a synchronous void return must not be assimilated");
      },
    });
    const fileSystem = { ...fs };
    fileSystem.openSync = function (this: unknown, ...args: Parameters<typeof fs.openSync>) {
      expect(this).toBe(fileSystem);
      const fd = fs.openSync(...args);
      expect(live.has(fd)).toBe(false);
      live.add(fd);
      return fd;
    } as typeof fs.openSync;
    fileSystem.writeFileSync = function (this: unknown, ...args: Parameters<typeof fs.writeFileSync>) {
      expect(this).toBe(fileSystem);
      fs.writeFileSync(...args);
      counts.writes++;
      return ignored;
    } as typeof fs.writeFileSync;
    fileSystem.fchmodSync = function (this: unknown, fd: number, mode: fs.Mode) {
      expect(this).toBeUndefined();
      fs.fchmodSync(fd, mode);
      counts.chmods++;
      return ignored;
    } as typeof fs.fchmodSync;
    fileSystem.closeSync = function (this: unknown, fd: number) {
      expect(this).toBe(fileSystem);
      expect(live.delete(fd)).toBe(true);
      fs.closeSync(fd);
      counts.closes++;
      return ignored;
    } as typeof fs.closeSync;
    if (route === "copy-fallback") {
      fileSystem.renameSync = () => { throw Object.assign(new Error("rename denied"), { code: "EPERM" }); };
    }
    const refusal = new Error("publication refused");
    let result: unknown, rejected: unknown;
    try {
      try {
        result = replaceFileAtomicSync({
          filePath, content: "replacement", fileSystem,
          copyFallbackOnPermissionError: true, destinationHardlinks: "reject",
          assertBeforeMutation() {},
          beforeRename() { if (route === "refusal") throw refusal; },
        });
      } catch (error) {
        rejected = error;
      }
      if (route === "refusal") expect(rejected).toBe(refusal);
      else {
        expect(rejected).toBeUndefined();
        expect(result).toEqual({ method: route });
      }
      expect(live.size).toBe(0);
      expect(thenReads).toBe(0);
      expect(counts.writes).toBeGreaterThan(0);
      expect(counts.chmods).toBeGreaterThan(0);
      expect(counts.closes).toBeGreaterThan(0);
      expect(fs.readdirSync(directory)).toEqual(["target"]);
      expect(fs.readFileSync(filePath, "utf8")).toBe(route === "refusal" ? "original" : "replacement");
    } finally {
      releaseDescriptors(live);
    }
  },
);

type DescriptorFile = {
  fd: number;
  stat(options?: fs.StatOptions): Promise<fs.Stats | fs.BigIntStats>;
  readFile(): Promise<Buffer>;
  writeFile(data: string | Uint8Array): undefined;
  chmod(mode: number): undefined;
  close(): undefined;
};

it.each(["rename", "copy-fallback"] as const)(
  "awaits undefined async void results before the next adapter call during %s", async route => {
    const directory = await tempRoot("fs-safe-atomic-async-void-");
    const filePath = path.join(directory, "target");
    fs.writeFileSync(filePath, "original", { mode: 0o600 });
    const live = new Set<number>(), pending = new Set<symbol>();
    const handles = new WeakSet<DescriptorFile>();
    const events: string[] = [];
    let stage: string | undefined, moduleWrites = 0;
    const ready = (operation: string) => {
      expect(pending.size, `${operation} ran before the previous void result was awaited`).toBe(0);
    };
    const completed = (event: string): undefined => {
      events.push(event);
      const token = Symbol(event);
      pending.add(token);
      queueMicrotask(() => {
        pending.delete(token);
        events.push(`${event}:awaited`);
      });
      return undefined;
    };
    const promises = { ...fsp };
    promises.open = async function (this: unknown, ...args: Parameters<typeof fsp.open>) {
      ready("open");
      expect(this).toBe(promises);
      const fd = fs.openSync(...args);
      expect(live.has(fd)).toBe(false);
      live.add(fd);
      const pathname = String(args[0]);
      if (args[1] === "wx") stage = pathname;
      const label = pathname === directory ? "directory"
        : args[1] === "wx" ? "stage" : pathname === stage ? "source" : "destination";
      // This adapter owns numeric descriptors; it never relabels a Node FileHandle.
      const handle: DescriptorFile = {
        fd,
        stat(options) {
          ready(`${label}:stat`);
          expect(this).toBe(handle);
          return Promise.resolve(fs.fstatSync(fd, options));
        },
        readFile() {
          ready(`${label}:read`);
          expect(this).toBe(handle);
          return Promise.resolve(fs.readFileSync(fd));
        },
        writeFile(data) {
          ready(`${label}:write`);
          expect(this).toBe(handle);
          fs.writeFileSync(fd, data);
          return completed(`${label}:write`);
        },
        chmod(mode) {
          ready(`${label}:chmod`);
          expect(this).toBe(handle);
          fs.fchmodSync(fd, mode);
          return completed(`${label}:chmod`);
        },
        close() {
          ready(`${label}:close`);
          expect(this).toBe(handle);
          expect(live.delete(fd)).toBe(true);
          fs.closeSync(fd);
          return completed(`${label}:close`);
        },
      };
      handles.add(handle);
      return handle as unknown as FileHandle;
    } as typeof fsp.open;
    promises.lstat = function (this: unknown, ...args: Parameters<typeof fsp.lstat>) {
      ready("lstat");
      expect(this).toBe(promises);
      return fsp.lstat(...args);
    } as typeof fsp.lstat;
    promises.writeFile = function (this: unknown, handle: DescriptorFile, data: string | Uint8Array): undefined {
      ready("module writeFile");
      expect(this).toBe(promises);
      expect(handles.has(handle)).toBe(true);
      moduleWrites++;
      return handle.writeFile(data);
    } as unknown as typeof fsp.writeFile;
    promises.rename = function (this: unknown, source: fs.PathLike, destination: fs.PathLike) {
      ready("rename");
      expect(this).toBe(promises);
      if (route === "copy-fallback") throw Object.assign(new Error("rename denied"), { code: "EPERM" });
      return fsp.rename(source, destination);
    };
    try {
      const result = await replaceFileAtomic({
        filePath, content: "replacement", fileSystem: { promises },
        copyFallbackOnPermissionError: true,
      });
      expect(result).toEqual({ method: route });
      expect(live.size).toBe(0);
      expect(pending.size).toBe(0);
      expect(moduleWrites).toBe(1);
      for (const event of ["stage:write", "stage:chmod", "stage:close"]) {
        expect(events).toContain(event);
        expect(events).toContain(`${event}:awaited`);
      }
      if (route === "copy-fallback") {
        expect(events).toContain("source:close");
        expect(events).toContain("destination:write");
        expect(events).toContain("destination:chmod");
        expect(events).toContain("destination:close");
      }
      expect(fs.readdirSync(directory)).toEqual(["target"]);
      expect(fs.readFileSync(filePath, "utf8")).toBe("replacement");
    } finally {
      releaseDescriptors(live);
    }
  },
);
