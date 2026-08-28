import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { configureFsSafeNative, root } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { resolveOpenedFileRealPathForFd, resolveOpenedFileRealPathForHandle } from "../src/opened-realpath.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { resolveRootContext } from "../src/root-context.js";
import * as verification from "../src/root-write-verification.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const verify = verification.verifyAtomicWriteResult;
const inode = 9007199254740993n;
const device = 9007199254740995n;
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
  __setFsSafeTestHooksForTest();
});

// Project only regular-file metadata; directory guards and actual I/O stay real.
function project<T extends Stats | BigIntStats>(stat: T, ino = inode, dev = device): T {
  if (!stat.isFile()) return stat;
  return Object.assign(Object.create(stat), {
    dev: typeof stat.dev === "bigint" ? dev : Number(dev),
    ino: typeof stat.ino === "bigint" ? ino : Number(ino),
  });
}

describe("Root exact publication identity", () => {
  it.each(["unchanged", "fd mismatch", "path mismatch", "canonical mismatch", "unknown Windows path"])(
    "handles a large exact inode: %s",
    async (scenario) => {
      const directory = await tempRoot("fs-safe-exact-verification-");
      const target = path.join(directory, "target");
      const handle = await fs.open(target, "wx", 0o600);
      const context = await resolveRootContext(directory);
      const parentGuard = await createAsyncDirectoryGuard(directory);
      await handle.writeFile("payload");
      const expectedInode = scenario.includes("mismatch") ? inode - 1n : inode;
      const expectedDevice = scenario.includes("mismatch") ? 17n : device;
      expect(Number(inode)).toBe(Number(inode - 1n));
      if (scenario === "unknown Windows path") Object.defineProperty(process, "platform", { value: "win32" });
      const fstat = fsSync.fstatSync.bind(fsSync);
      const lstat = fs.lstat.bind(fs);
      const stat = fs.stat.bind(fs);
      vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) => {
        const actual = fstat(...args);
        return actual.isFile() ? project(actual, scenario === "fd mismatch" ? inode : expectedInode, expectedDevice) : actual;
      }) as typeof fsSync.fstatSync);
      vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
        const actual = await lstat(...args);
        if (String(args[0]) !== target) return actual;
        return scenario === "unknown Windows path" ? project(actual, 0n, 0n)
          : project(actual, scenario === "path mismatch" ? inode : expectedInode, expectedDevice);
      }) as typeof fs.lstat);
      vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
        const actual = await stat(...args);
        if (String(args[0]) !== target) return actual;
        return scenario === "unknown Windows path" ? project(actual, 0n, 0n)
          : project(actual, scenario === "canonical mismatch" ? inode : expectedInode, expectedDevice);
      }) as typeof fs.stat);
      try {
        const pending = verify({ root: context, targetPath: target, fd: handle.fd,
          expectedIdentity: { dev: expectedDevice, ino: expectedInode }, parentGuard });
        if (scenario.includes("mismatch")) await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
        else await expect(pending).resolves.toBeUndefined();
      } finally {
        await handle.close();
      }
    },
  );

  it.each(["descriptor", "pathname", "parent scan", "numeric handle wrapper"])(
    "uses the expected metadata precision for %s realpath resolution",
    async (route) => {
      const directory = await tempRoot("fs-safe-exact-realpath-");
      const target = path.join(directory, "target");
      const handle = await fs.open(target, "wx", 0o600);
      const realpath = fs.realpath.bind(fs);
      const stat = fs.stat.bind(fs);
      const lstat = fs.lstat.bind(fs);
      const handleStat = handle.stat.bind(handle);
      let pathnameAttempts = 0;
      vi.spyOn(handle, "stat").mockImplementation((async (...args: Parameters<typeof handle.stat>) =>
        project(await handleStat(...args))) as typeof handle.stat);
      vi.spyOn(fs, "realpath").mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
        const candidate = String(args[0]);
        if (candidate.startsWith("/dev/fd/") || candidate.startsWith("/proc/self/fd/")) {
          if (route === "descriptor") return target;
          throw Object.assign(new Error("no descriptor alias"), { code: "ENOENT" });
        }
        if (candidate === target && route === "parent scan" && pathnameAttempts++ === 0) {
          throw Object.assign(new Error("pathname raced"), { code: "ENOENT" });
        }
        return await realpath(...args);
      }) as typeof fs.realpath);
      const sampled: Array<number | bigint> = [];
      vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
        const actual = await stat(...args);
        if (String(args[0]) !== target) return actual;
        const projected = project(actual);
        sampled.push(projected.ino);
        return projected;
      }) as typeof fs.stat);
      vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
        const actual = await lstat(...args);
        if (String(args[0]) !== target) return actual;
        const projected = project(actual);
        sampled.push(projected.ino);
        return projected;
      }) as typeof fs.lstat);
      try {
        const pending = route === "numeric handle wrapper"
          ? resolveOpenedFileRealPathForHandle(handle, target)
          : resolveOpenedFileRealPathForFd(handle.fd, { dev: device, ino: inode }, target);
        await expect(pending).resolves.toBe(target);
        expect(sampled.length).toBeGreaterThan(0);
        expect(sampled.every((value) => typeof value === (route === "numeric handle wrapper" ? "number" : "bigint"))).toBe(true);
      } finally {
        await handle.close();
      }
    },
  );
});

const routes = ["javascript", "windows fallback", "native POSIX", "windows native"] as const;
for (const route of routes) {
  describe.skipIf((route.includes("native") && !nativeAvailable) || (route === "native POSIX" && process.platform === "win32"))(
    `exact private callback: ${route}`,
    () => {
      it.each(["write", "create"].flatMap((operation) =>
        [false, true].map((changed) => ({ operation, changed })),
      ))("$operation preserves the original snapshot (changed after publication: $changed)", async ({ operation, changed }) => {
        const directory = await tempRoot("fs-safe-exact-callback-");
        const target = path.join(directory, "target");
        if (route === "windows fallback" && operation === "write") await fs.writeFile(target, "old");
        const context = await resolveRootContext(directory);
        const capability = await root(directory);
        const binding = route.includes("native") ? __loadBundledNativeForTest() : undefined;
        if (route.startsWith("windows")) Object.defineProperty(process, "platform", { value: "win32" });
        let published = false;
        const currentInode = () => changed && published ? inode - 1n : inode;
        const fstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) =>
          project(fstat(...args), currentInode())) as typeof fsSync.fstatSync);
        for (const method of ["stat", "lstat"] as const) {
          const original = fs[method].bind(fs);
          vi.spyOn(fs, method).mockImplementation((async (...args: Parameters<typeof fs.stat>) =>
            project(await original(...args), currentInode())) as typeof fs.stat);
        }
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          const stat = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation((async (...options: Parameters<typeof handle.stat>) =>
            project(await stat(...options), currentInode())) as typeof handle.stat);
          return handle;
        });
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          await rename(...args);
          published = true;
        });
        if (binding) {
          __setNativeLoaderForTest(() => ({
            ...binding,
            fstatIdentity(fd) {
              const actual = binding.fstatIdentity(fd);
              return actual.isFile ? { ...actual, dev: Number(device), ino: Number(currentInode()) } : actual;
            },
            renameReplace(...args) { binding.renameReplace(...args); published = true; },
            renameNoReplace(...args) { binding.renameNoReplace(...args); published = true; },
          }));
        }
        configureFsSafeNative({ mode: route.includes("native") ? "require" : "off" });
        let callbacks = 0;
        let fd: number | undefined;
        const check: typeof verify = async (params) => {
          callbacks++;
          fd = params.fd;
          expect(params.expectedIdentity).toMatchObject({ dev: device, ino: inode });
          // Direct-create paths have no rename; mutate only after their expected snapshot.
          published = true;
          await verify(params);
        };
        let pending: Promise<unknown>;
        if (route === "windows fallback") {
          vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(check);
          pending = operation === "create" ? capability.create("target", "payload") : capability.write("target", "payload");
        } else {
          pending = runPinnedWriteHelper({
            rootPath: directory, relativeParentPath: "", basename: "target", mkdir: false,
            mode: 0o600, overwrite: operation === "write", input: { kind: "buffer", data: "payload" },
            verifyPublished: async (fd, expectedIdentity, parentGuard) =>
              await check({ root: context, targetPath: target, fd, expectedIdentity, parentGuard }),
          });
        }
        if (changed) await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
        else {
          const result = await pending;
          if (route === "windows fallback") expect(result).toBeUndefined();
          else expect(result).toMatchObject(route === "native POSIX"
            ? { dev: device, ino: inode } : { dev: Number(device), ino: Number(inode) });
        }
        expect(callbacks).toBe(1);
        expect(() => fstat(fd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
        vi.restoreAllMocks();
        expect(await fs.readFile(target, "utf8")).toBe("payload");
        expect(await fs.readdir(directory)).toEqual(["target"]);
      });
    },
  );
}

it.skipIf(process.platform === "win32")("passes the exact content-accepted FUSE destination identity to Root", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-exact-fuse-");
  const target = path.join(directory, "target");
  const original = path.join(directory, "original");
  __setFsSafeTestHooksForTest({ async afterPinnedWriteFallbackRename() {
    await fs.rename(target, original);
    await fs.writeFile(target, "payload");
  } });
  const check = vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
    const accepted = fsSync.fstatSync(params.fd, { bigint: true });
    expect(params.expectedIdentity).toMatchObject({ dev: accepted.dev, ino: accepted.ino });
    expect(accepted.ino).not.toBe((await fs.stat(original, { bigint: true })).ino);
    await verify(params);
  });
  const capability = await root(directory, { renameIdentity: "verify-content-with-lock" });
  await expect(capability.write("target", "payload")).resolves.toBeUndefined();
  expect(check).toHaveBeenCalledTimes(1);
});

for (const backend of ["fallback", "native"] as const) {
  describe.skipIf(backend === "native" && !nativeAvailable)(
    `Windows opaque pathname identity with ${backend}`,
    () => {
      it.each(["write", "create"].flatMap((operation) =>
        ["known identity", "unchanged", "same bytes", "different bytes", "read error"].map(
          (behavior) => ({ operation, behavior }),
        ),
      ))("$operation: $behavior", async ({ operation, behavior }) => {
        const directory = await tempRoot("fs-safe-windows-opaque-write-");
        const target = path.join(directory, "target");
        const published = path.join(directory, "published");
        const payload = "mode-zero-proof";
        const swapped = behavior === "same bytes" || behavior === "different bytes";
        if (operation === "write") await fs.writeFile(target, "old", { mode: 0o600 });
        const binding = backend === "native" ? __loadBundledNativeForTest() : undefined;
        if (binding) __setNativeLoaderForTest(() => binding);
        configureFsSafeNative({ mode: backend === "native" ? "require" : "off" });
        // POSIX hosts exercise the Windows branch; Windows CI runs its real mechanism.
        Object.defineProperty(process, "platform", { value: "win32" });
        const capability = await root(directory);
        const failure = Object.assign(new Error("opaque pathname cannot be opened"), { code: "EACCES" });
        let opaque = false;
        let retainedFd: number | undefined;
        let reopens = 0;
        const reopened: Array<{ fd: number }> = [];
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (!opaque || String(args[0]) !== target) return await open(...args);
          reopens++;
          if (behavior === "read error") throw failure;
          const handle = await open(...args);
          reopened.push(handle);
          return handle;
        });
        for (const method of ["stat", "lstat"] as const) {
          const original = fs[method].bind(fs);
          vi.spyOn(fs, method).mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
            const stat = await original(...args);
            if (!opaque || String(args[0]) !== target) return stat;
            return Object.assign(Object.create(stat), {
              dev: typeof stat.dev === "bigint" ? 0n : 0,
              ino: typeof stat.ino === "bigint" ? 0n : 0,
            });
          }) as typeof fs.stat);
        }
        const verifier = vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(
          async (params) => {
            expect(params.targetPath).toBe(target);
            retainedFd = params.fd;
            if (swapped) {
              await fs.rename(target, published);
              await fs.writeFile(target, behavior === "same bytes" ? payload : "replacement", { mode: 0o600 });
            }
            opaque = behavior !== "known identity";
            await verify(params);
          },
        );
        const pending = operation === "create"
          ? capability.create("target", payload, { mode: 0o600 })
          : capability.write("target", payload, { mode: 0o600 });
        if (swapped) await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
        else if (behavior === "read error") await expect(pending).rejects.toBe(failure);
        else await expect(pending).resolves.toBeUndefined();
        expect(verifier).toHaveBeenCalledTimes(1);
        expect(reopens).toBe(behavior === "known identity" ? 0 : 1);
        expect(reopened.every((handle) => handle.fd === -1)).toBe(true);
        expect(() => fsSync.fstatSync(retainedFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
        vi.restoreAllMocks();
        expect(await fs.readFile(swapped ? published : target, "utf8")).toBe(payload);
        if (swapped) expect(await fs.readFile(target, "utf8")).toBe(behavior === "same bytes" ? payload : "replacement");
        expect((await fs.readdir(directory)).sort()).toEqual(swapped ? ["published", "target"] : ["target"]);
      });
    },
  );
}
