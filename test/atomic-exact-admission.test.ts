import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertDestinationHardlinkPolicy, assertDestinationHardlinkPolicySync, copyFallbackReplace, copyFallbackReplaceSync } from "../src/replace-file-copy-fallback.js";
import { readOwnedCopySource, readOwnedCopySourceSync } from "../src/replace-file-copy-source.js";
import { applyDirectoryMode, applyDirectoryModeSync } from "../src/replace-file-descriptor.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const firstInode = (1n << 56n) + 1n, secondInode = (1n << 56n) + 3n;

function collisionAdapter(selected: string, other: string, redirect: boolean) {
  const first = fs.lstatSync(selected, { bigint: true }), second = fs.lstatSync(other, { bigint: true });
  const project = <T extends fs.Stats | fs.BigIntStats>(stat: T): T => {
    const ino = stat.ino === first.ino || stat.ino === Number(first.ino) ? firstInode
      : stat.ino === second.ino || stat.ino === Number(second.ino) ? secondInode : undefined;
    if (ino !== undefined) stat.ino = typeof stat.ino === "bigint" ? ino : Number(ino);
    return stat;
  };
  const watched = new Set<number>();
  let reads = 0, mutations = 0, opens = 0, closes = 0, pathObservations = 0, fdObservations = 0;
  const sync = {
    ...fs,
    lstatSync: ((...args) => {
      if (String(args[0]) === selected) pathObservations++;
      return project(fs.lstatSync(...args));
    }) as typeof fs.lstatSync,
    fstatSync: ((...args) => {
      if (watched.has(args[0])) fdObservations++;
      return project(fs.fstatSync(...args));
    }) as typeof fs.fstatSync,
    openSync: ((name, ...args) => {
      const fd = fs.openSync(redirect && String(name) === selected ? other : name, ...args);
      if (String(name) === selected) { watched.add(fd); opens++; }
      return fd;
    }) as typeof fs.openSync,
    closeSync(fd: number) { if (watched.delete(fd)) closes++; fs.closeSync(fd); },
    readSync: ((fd, ...args) => { if (watched.has(fd)) reads++; return Reflect.apply(fs.readSync, fs, [fd, ...args]); }) as typeof fs.readSync,
    writeSync: ((fd, ...args) => { if (watched.has(fd)) mutations++; return Reflect.apply(fs.writeSync, fs, [fd, ...args]); }) as typeof fs.writeSync,
    ftruncateSync(fd: number, len?: number) { if (watched.has(fd)) mutations++; fs.ftruncateSync(fd, len); },
    fchmodSync(fd: number, mode: fs.Mode) { if (watched.has(fd)) mutations++; fs.fchmodSync(fd, mode); },
  };
  const async = {
    ...fsp,
    lstat: (async (...args) => {
      if (String(args[0]) === selected) pathObservations++;
      return project(await fsp.lstat(...args));
    }) as typeof fsp.lstat,
    open: (async (name, ...args) => {
      const handle = await fsp.open(redirect && String(name) === selected ? other : name, ...args);
      const tracked = String(name) === selected;
      if (tracked) opens++;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat") return async (...args: Parameters<FileHandle["stat"]>) => {
            if (tracked) fdObservations++;
            return project(await target.stat(...args));
          };
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (tracked && (key === "read" || key === "readFile")) reads++;
            if (tracked && ["write", "writeFile", "truncate", "chmod"].includes(String(key))) mutations++;
            if (tracked && key === "close") closes++;
            return Reflect.apply(value, target, args);
          };
        },
      });
    }) as typeof fsp.open,
  };
  return { sync, async, expectedIdentity: project(fs.lstatSync(selected, { bigint: true })),
    counts: () => ({ reads, mutations, opens, closes, pathObservations, fdObservations }) };
}

for (const synchronous of [false, true]) {
  describe(`exact atomic descriptor admission (sync=${synchronous})`, () => {
    it.each([false, true])("uses one exact source pair after preview (owner receipt=%s)", async owned => {
      const directory = await tempRoot("fs-safe-atomic-source-observations-");
      const source = path.join(directory, "source"), other = path.join(directory, "other");
      fs.writeFileSync(source, "payload"); fs.writeFileSync(other, "unrelated");
      const adapter = collisionAdapter(source, other, false);
      const options = { src: source, expectedIdentity: owned ? adapter.expectedIdentity : undefined };
      const result = synchronous ? readOwnedCopySourceSync({ ...options, fsModule: adapter.sync })
        : await readOwnedCopySource({ ...options, fsModule: adapter.async });
      expect(result.replacement.toString()).toBe("payload");
      expect(adapter.counts()).toMatchObject({ pathObservations: 2, fdObservations: 1, opens: 1, closes: 1 });
    });

    it.each(["transient", "persistent", "alternating", "known-mismatch"])("bounds modeled Windows %s identity observations", async fault => {
      const directory = await tempRoot("fs-safe-atomic-unknown-identity-");
      const dest = path.join(directory, "dest"), other = path.join(directory, "other"), source = path.join(directory, "source");
      fs.writeFileSync(dest, "original"); fs.writeFileSync(other, "unrelated"); fs.writeFileSync(source, "replacement");
      const adapter = collisionAdapter(dest, other, false);
      let observations = 0;
      const damage = (stat: fs.Stats | fs.BigIntStats) => {
        if (typeof stat.ino !== "bigint" || stat.ino !== firstInode) return stat;
        observations++;
        if (observations === 1) {
          stat.dev = 0n;
          if (fault === "known-mismatch") stat.ino = secondInode;
        } else if (fault === "persistent") stat.dev = 0n;
        else if (fault === "alternating") stat.ino = 0n;
        return stat;
      };
      const fstat = adapter.sync.fstatSync;
      adapter.sync.fstatSync = ((...args) => damage(fstat(...args))) as typeof fstat;
      const open = adapter.async.open;
      adapter.async.open = (async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) !== dest) return handle;
        return new Proxy(handle, { get(target, key) {
          if (key === "stat") return async (...options: Parameters<FileHandle["stat"]>) => damage(await target.stat(...options));
          return Reflect.get(target, key);
        } });
      }) as typeof open;
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        const options = { src: source, dest, restore: "restore-original" as const, maxRestoreBytes: 64, sync: false };
        const run = async () => synchronous ? copyFallbackReplaceSync({ ...options, fsModule: adapter.sync })
          : await copyFallbackReplace({ ...options, fsModule: adapter.async });
        if (fault === "transient") await run();
        else await expect(run()).rejects.toMatchObject({ code: "path-mismatch" });
      } finally { Object.defineProperty(process, "platform", platform); }
      expect(observations).toBe(2);
      expect(adapter.counts()).toMatchObject({ opens: 1, closes: 1 });
      if (fault !== "transient") expect(adapter.counts()).toMatchObject({ reads: 0, mutations: 0 });
      expect(fs.readFileSync(dest, "utf8")).toBe(fault === "transient" ? "replacement" : "original");
      expect(fs.readFileSync(other, "utf8")).toBe("unrelated");
    });

    for (const operation of ["source", "restore", "hardlinks", "parent"] as const) {
      it.skipIf(operation === "parent" && process.platform === "win32").each([false, true])(
        `${operation} rejects a numerically colliding replacement (redirect=%s)`, async redirect => {
          expect(Number(firstInode)).toBe(Number(secondInode));
          const directory = await tempRoot("fs-safe-atomic-exact-");
          const selected = path.join(directory, "selected"), other = path.join(directory, "other");
          if (operation === "parent") {
            fs.mkdirSync(selected, { mode: 0o755 }); fs.mkdirSync(other, { mode: 0o755 });
            fs.chmodSync(selected, 0o755); fs.chmodSync(other, 0o755);
          } else {
            fs.writeFileSync(selected, "original"); fs.writeFileSync(other, "unrelated");
          }
          const adapter = collisionAdapter(selected, other, redirect);
          const run = async () => {
            if (operation === "source") return synchronous
              ? readOwnedCopySourceSync({ fsModule: adapter.sync, src: selected })
              : await readOwnedCopySource({ fsModule: adapter.async, src: selected });
            if (operation === "hardlinks") return synchronous
              ? assertDestinationHardlinkPolicySync(adapter.sync, selected, "reject")
              : await assertDestinationHardlinkPolicy(adapter.async, selected, "reject");
            if (operation === "parent") return synchronous
              ? applyDirectoryModeSync({ fsModule: adapter.sync, dirPath: selected, mode: 0o700, fchmodSync: adapter.sync.fchmodSync })
              : await applyDirectoryMode({ fsModule: adapter.async, dirPath: selected, mode: 0o700 });
            const source = path.join(directory, "source"); fs.writeFileSync(source, "replacement");
            const options = { src: source, dest: selected, restore: "restore-original" as const, maxRestoreBytes: 64, sync: false };
            return synchronous ? copyFallbackReplaceSync({ ...options, fsModule: adapter.sync })
              : await copyFallbackReplace({ ...options, fsModule: adapter.async });
          };
          if (redirect) await expect(run()).rejects.toMatchObject({ code: "path-mismatch" });
          else await run();
          const counts = adapter.counts();
          expect(counts.opens).toBe(1); expect(counts.closes).toBe(1);
          if (redirect) { expect(counts.reads).toBe(0); expect(counts.mutations).toBe(0); }
          if (operation === "parent") {
            expect(fs.statSync(other).mode & 0o777).toBe(0o755);
            expect(fs.statSync(selected).mode & 0o777).toBe(redirect ? 0o755 : 0o700);
          } else {
            expect(fs.readFileSync(other, "utf8")).toBe("unrelated");
            expect(fs.readFileSync(selected, "utf8")).toBe(!redirect && operation === "restore" ? "replacement" : "original");
          }
        },
      );
    }
  });
}
