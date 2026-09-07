import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

const writers = [
  { operation: "write", write: writeSecretFileAtomic },
  { operation: "create", write: createSecretFileAtomic },
];

describe.skipIf(!nativeAvailable)("native Windows final-mode ownership", () => {
  it.each(writers.flatMap((writer) => ["stable", "before-open", "mode-error"].map((scenario) => ({ ...writer, scenario }))))(
    "$operation retains final-mode ownership through $scenario",
    async ({ write, scenario }) => {
      const rootDir = await tempRoot("fs-safe-native-mode-owner-");
      const target = path.join(rootDir, "token");
      const saved = path.join(rootDir, "published");
      const binding = __loadBundledNativeForTest();
      const fstat = fsSync.fstatSync.bind(fsSync);
      const identities = new Map<string, bigint>();
      const base = 1n << 53n;
      expect(Number(base)).toBe(Number(base + 1n));
      const key = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;
      const projectedInode = (stat: BigIntStats) => {
        const id = key(stat);
        if (!identities.has(id)) identities.set(id, base + BigInt(identities.size));
        return identities.get(id)!;
      };
      // Only inode values are projected; descriptors, bytes, replacement and chmod are real.
      const project = <T extends Stats | BigIntStats>(stat: T, exact: BigIntStats): T => {
        if (!stat.isFile()) return stat;
        const ino = projectedInode(exact);
        return Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
      };
      vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) =>
        project(fstat(...args), fstat(args[0], { bigint: true }))) as typeof fsSync.fstatSync);
      for (const method of ["lstat", "stat"] as const) {
        const original = fs[method].bind(fs);
        vi.spyOn(fs, method).mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
          const stat = await original(...args);
          if (!stat.isFile()) return stat;
          return project(stat, await original(args[0], { bigint: true }));
        }) as typeof fs.stat);
      }
      const statSync = fsSync.statSync.bind(fsSync);
      vi.spyOn(fsSync, "statSync").mockImplementation(((...args: Parameters<typeof fsSync.statSync>) =>
        project(statSync(...args), statSync(args[0], { bigint: true }))) as typeof fsSync.statSync);
      const lstatSync = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) =>
        project(lstatSync(...args), lstatSync(args[0], { bigint: true }))) as typeof fsSync.lstatSync);
      let published = false;
      let replaced = false;
      let replacementIdentity: string | undefined;
      const swap = () => {
        fsSync.renameSync(target, saved);
        fsSync.writeFileSync(target, "replacement", { mode: 0o600 });
        fsSync.chmodSync(target, 0o600);
        replacementIdentity = key(fsSync.statSync(target, { bigint: true }));
        replaced = true;
      };
      const modeFailure = Object.assign(new Error("synthetic final chmod failure"), { code: "EIO" });
      const chmod = fsSync.fchmodSync.bind(fsSync);
      const changes: Array<{ identity: string; mode: number }> = [];
      vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
        if (scenario === "mode-error" && Number(mode) === 0o400) {
          swap();
          throw modeFailure;
        }
        chmod(fd, mode);
        changes.push({ identity: key(fstat(fd, { bigint: true })), mode: Number(mode) });
      });
      __setNativeLoaderForTest(() => ({
        ...binding,
        renameReplace(...args) { binding.renameReplace(...args); published = true; },
        renameNoReplace(...args) { binding.renameNoReplace(...args); published = true; },
        openBeneath(...args) {
          if (scenario === "before-open" && published && args[1] === "token" && !replaced) swap();
          return binding.openBeneath(...args);
        },
        fstatIdentity(fd) {
          const stat = binding.fstatIdentity(fd);
          return stat.isFile ? { ...stat, ino: Number(projectedInode(fstat(fd, { bigint: true }))) } : stat;
        },
      }));
      // POSIX hosts exercise the Windows branch; Windows CI uses its actual native mechanism.
      Object.defineProperty(process, "platform", { value: "win32" });
      configureFsSafeNative({ mode: "require" });
      const pending = write({ rootDir, filePath: target, content: "original", mode: 0o400 });
      if (scenario !== "stable") {
        if (scenario === "mode-error") await expect(pending).rejects.toBe(modeFailure);
        else await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
        expect(replaced).toBe(true);
        expect(changes.filter((change) => change.identity === replacementIdentity)).toEqual([]);
        expect(fsSync.existsSync(target)).toBe(true);
        expect(fsSync.statSync(target).mode & 0o200).toBe(0o200);
        expect(fsSync.readFileSync(target, "utf8")).toBe("replacement");
        expect(fsSync.readFileSync(saved, "utf8")).toBe("original");
      } else {
        await expect(pending).resolves.toBeUndefined();
        expect(fsSync.statSync(target).mode & 0o200).toBe(0);
        expect(fsSync.readFileSync(target, "utf8")).toBe("original");
      }
    },
  );
});
