import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import * as verification from "../src/root-write-verification.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const { tempRoot } = useRealTempDirs();
const verifyPublished = verification.verifyAtomicWriteResult;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  __setFsSafeTestHooksForTest();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

describe.skipIf(process.platform === "win32")("FUSE accepted descriptor lifetime", () => {
  it.each(["matching", "changed", "unreadable", "outer replacement", "outer I/O"])(
    "%s content keeps proof and lock cleanup intact",
    async (scenario) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-mode-fuse-");
      const target = path.join(directory, "target");
      const original = path.join(directory, "original");
      const mode = scenario === "unreadable" ? 0 : 0o600;
      const handles: FileHandle[] = [];
      let replacementReached = false;
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        handles.push(handle);
        return handle;
      });
      __setFsSafeTestHooksForTest({
        async afterPinnedWriteFallbackRename(targetPath) {
          replacementReached = true;
          expect(targetPath).toBe(target);
          await fs.rename(target, original);
          await fs.writeFile(target, scenario === "changed" ? "changed" : "payload", { mode });
        },
      });
      let retainedFd: number | undefined;
      const sentinel = Object.assign(new Error("outer verification failed"), { code: "EIO" });
      const verifier = vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
        retainedFd = params.fd;
        expect(fsSync.fstatSync(params.fd).ino).toBe((await fs.stat(target)).ino);
        expect(fsSync.fstatSync(params.fd).ino).not.toBe((await fs.stat(original)).ino);
        expect(handles.find((handle) => handle.fd === params.fd)).toBeDefined();
        if (scenario === "outer replacement") {
          await fs.rename(target, path.join(directory, "accepted"));
          await fs.writeFile(target, "payload", { mode });
        } else if (scenario === "outer I/O") {
          const realLstat = fs.lstat.bind(fs);
          vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
            if (String(args[0]) === target) throw sentinel;
            return await realLstat(...args);
          }) as typeof fs.lstat);
        }
        await verifyPublished(params);
      });
      const safe = await root(directory, { renameIdentity: "verify-content-with-lock" });
      const pending = safe.write("target", "payload", { mode });
      if (scenario === "matching" || (scenario === "unreadable" && process.getuid?.() === 0)) {
        await expect(pending).resolves.toBeUndefined();
      } else if (scenario === "outer I/O") {
        await expect(pending).rejects.toBe(sentinel);
      } else if (scenario === "unreadable") {
        await expect(pending).rejects.toMatchObject({ code: "invalid-path", cause: { code: "EACCES" } });
      } else {
        await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
      }
      expect(replacementReached).toBe(true);
      expect(verifier).toHaveBeenCalledTimes(
        scenario === "changed" || (scenario === "unreadable" && process.getuid?.() !== 0) ? 0 : 1,
      );
      if (retainedFd !== undefined) {
        expect(() => fsSync.fstatSync(retainedFd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
      }
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      vi.restoreAllMocks();
      expect((await fs.stat(target)).mode & 0o777).toBe(mode);
      expect((await fs.stat(original)).mode & 0o777).toBe(mode);
      await fs.chmod(target, 0o600);
      await fs.chmod(original, 0o600);
      expect(await fs.readFile(target, "utf8")).toBe(scenario === "changed" ? "changed" : "payload");
      expect(await fs.readFile(original, "utf8")).toBe("payload");
      expect((await fs.readdir(directory)).sort()).toEqual(
        scenario === "outer replacement" ? ["accepted", "original", "target"] : ["original", "target"],
      );
    },
  );
});

for (const backend of ["javascript", "native", "windows fallback branch"] as const) {
  describe.skipIf(process.platform === "win32" || (backend === "native" && !nativeAvailable))(
    `publication cleanup: ${backend}`,
    () => {
      it.skipIf(backend !== "native")("surfaces a successful publication's close failure and closes the other native descriptors", async () => {
        const binding = __loadBundledNativeForTest();
        const descriptors: number[] = [];
        __setNativeLoaderForTest(() => ({
          ...binding,
          openBeneath(...args) {
            const opened = binding.openBeneath(...args);
            descriptors.push(opened.fd);
            return opened;
          },
          createStagedFile(...args) {
            const fd = binding.createStagedFile!(...args);
            descriptors.push(fd);
            return fd;
          },
        }));
        configureFsSafeNative({ mode: "require" });
        const directory = await tempRoot("fs-safe-mode-native-close-");
        const safe = await root(directory);
        const sentinel = Object.assign(new Error("close failed after publication"), { code: "EIO" });
        let closed = false;
        vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
          await verifyPublished(params);
          const realClose = fsSync.closeSync.bind(fsSync);
          vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
            realClose(fd);
            if (fd === params.fd) {
              closed = true;
              throw sentinel;
            }
          });
        });
        await expect(safe.write("target", "payload", { mode: 0 })).rejects.toMatchObject({
          cause: sentinel,
          details: {
            phase: "cleanup", publication: { status: "published", basename: "target" },
            cleanup: { status: "not-needed", resources: "close-failed" },
          },
        });
        expect(closed).toBe(true);
        expect(descriptors).toHaveLength(2);
        for (const fd of descriptors) {
          expect(() => fsSync.fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
        }
        vi.restoreAllMocks();
        const target = path.join(directory, "target");
        expect((await fs.stat(target)).mode & 0o777).toBe(0);
        await fs.chmod(target, 0o600);
        expect(await fs.readFile(target, "utf8")).toBe("payload");
        expect(await fs.readdir(directory)).toEqual(["target"]);
      });

      it.each(["identity", "unknown identity", "type"])("rechecks fresh fd %s even with unknown Windows pathname identity", async (change) => {
        configureFsSafeNative({ mode: backend === "native" ? "require" : "off" });
        if (backend === "windows fallback branch") Object.defineProperty(process, "platform", { value: "win32" });
        const directory = await tempRoot("fs-safe-mode-fd-stat-");
        const target = path.join(directory, "target");
        const safe = await root(directory);
        let retainedFd: number | undefined;
        let fdChecks = 0;
        let unknownPathChecked = false;
        vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
          retainedFd = params.fd;
          const realFstat = fsSync.fstatSync.bind(fsSync);
          vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) => {
            const stat = realFstat(...args);
            if (args[0] !== params.fd) return stat;
            if (++fdChecks === 1) return stat;
            return Object.assign(Object.create(stat), change === "identity"
              ? { ino: BigInt(stat.ino) + 1n }
              : change === "unknown identity" ? { dev: 0n, ino: 0n }
                : { isFile: () => false });
          }) as typeof fsSync.fstatSync);
          if (backend === "windows fallback branch") {
            const realLstat = fs.lstat.bind(fs);
            vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
              const stat = await realLstat(...args);
              if (String(args[0]) !== target) return stat;
              unknownPathChecked = true;
              return Object.assign(Object.create(stat), { dev: 0, ino: 0 });
            }) as typeof fs.lstat);
          }
          await verifyPublished(params);
        });
        await expect(safe.write("target", "payload", { mode: 0 })).rejects.toMatchObject({
          code: change === "type" ? "not-file" : "path-mismatch",
        });
        expect(fdChecks).toBe(2);
        expect(unknownPathChecked).toBe(backend === "windows fallback branch");
        vi.restoreAllMocks();
        expect(() => fsSync.fstatSync(retainedFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
        expect((await fs.stat(target)).mode & 0o777).toBe(0);
        await fs.chmod(target, 0o600);
        expect(await fs.readFile(target, "utf8")).toBe("payload");
        expect(await fs.readdir(directory)).toEqual(["target"]);
      });

      it.each(["write", "create"])("%s close errors cannot mask a post-publication failure", async (operation) => {
        configureFsSafeNative({ mode: backend === "native" ? "require" : "off" });
        if (backend === "windows fallback branch") Object.defineProperty(process, "platform", { value: "win32" });
        const directory = await tempRoot("fs-safe-mode-close-");
        const target = path.join(directory, "target");
        const safe = await root(directory);
        const sentinel = Object.assign(new Error("verification failed"), { code: "EIO" });
        const closeFailure = new Error("close failed after closing");
        let retainedFd: number | undefined;
        let closed = false;
        const handles: FileHandle[] = [];
        const realOpen = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          handles.push(handle);
          return handle;
        });
        vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async ({ fd }) => {
          retainedFd = fd;
          if (backend === "native") {
            const realClose = fsSync.closeSync.bind(fsSync);
            vi.spyOn(fsSync, "closeSync").mockImplementation((closingFd) => {
              realClose(closingFd);
              if (closingFd === fd) {
                closed = true;
                throw closeFailure;
              }
            });
          } else {
            const handle = handles.find((candidate) => candidate.fd === fd)!;
            const realClose = handle.close.bind(handle);
            vi.spyOn(handle, "close").mockImplementation(async () => {
              await realClose();
              closed = true;
              throw closeFailure;
            });
          }
          throw sentinel;
        });
        const pending = operation === "create"
          ? safe.create("target", "payload", { mode: 0 })
          : safe.write("target", "payload", { mode: 0 });
        if (backend === "native") {
          await expect(pending).rejects.toMatchObject({
            name: "SuppressedError", suppressed: sentinel,
            error: {
              cause: closeFailure,
              details: {
                phase: "cleanup", publication: { status: "published", basename: "target" },
                cleanup: { status: "not-needed", resources: "close-failed" },
              },
            },
          });
        } else {
          await expect(pending).rejects.toBe(sentinel);
        }
        expect(closed).toBe(true);
        expect(() => fsSync.fstatSync(retainedFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
        expect(handles.every((handle) => handle.fd === -1)).toBe(true);
        vi.restoreAllMocks();
        expect((await fs.stat(target)).mode & 0o777).toBe(0);
        await fs.chmod(target, 0o600);
        expect(await fs.readFile(target, "utf8")).toBe("payload");
        expect(await fs.readdir(directory)).toEqual(["target"]);
      });
    },
  );
}

describe.skipIf(process.platform === "win32" || !nativeAvailable)("private native publication verification", () => {
  it.each(["resolve", "reject"])("retains its descriptor until an awaited verifier can %s", async (outcome) => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-private-verifier-");
    const safe = await root(directory);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error("verification failed after awaiting");
    let retainedFd: number | undefined;
    let completed = false;
    vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
      retainedFd = params.fd;
      await verifyPublished(params);
      entered.resolve();
      await release.promise;
      expect(fsSync.fstatSync(params.fd).mode & 0o777).toBe(0);
      if (outcome === "reject") throw failure;
    });
    const pending = safe.write("target", "payload", { mode: 0 }).then(
      () => { completed = true; return undefined; },
      (error: unknown) => { completed = true; entered.reject(error); return error; },
    );
    try {
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(fsSync.fstatSync(retainedFd!).mode & 0o777).toBe(0);
      expect(await fs.readdir(directory)).toEqual(["target"]);
    } finally {
      release.resolve();
    }
    expect(await pending).toBe(outcome === "reject" ? failure : undefined);
    expect(() => fsSync.fstatSync(retainedFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    const target = path.join(directory, "target");
    expect((await fs.stat(target)).mode & 0o777).toBe(0);
    await fs.chmod(target, 0o600);
    expect(await fs.readFile(target, "utf8")).toBe("payload");
  });

  it.each(["success", "EIO", "EACCES", "EPERM", "EEXIST"])(
    "retains the separate Windows leaf descriptor for %s verification (branch simulation)",
    async (outcome) => {
      const binding = __loadBundledNativeForTest();
      __setNativeLoaderForTest(() => binding);
      configureFsSafeNative({ mode: "require" });
      Object.defineProperty(process, "platform", { value: "win32" });
      const directory = await tempRoot("fs-safe-windows-native-verifier-");
      const target = path.join(directory, "target");
      const failure = Object.assign(new Error("Windows verification failed"), { code: outcome });
      let retainedFd: number | undefined;
      const pending = runPinnedWriteHelper({
        rootPath: directory, relativeParentPath: "", basename: "target", mkdir: false,
        mode: 0, input: { kind: "buffer", data: "payload" },
        verifyPublished: async (fd, identity, parentGuard) => {
          retainedFd = fd;
          expect(fsSync.fstatSync(fd, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino });
          expect(fsSync.fstatSync(fd).mode & 0o777).toBe(0);
          expect(parentGuard.stat).toMatchObject({ ino: (await fs.stat(directory)).ino });
          expect(parentGuard.realPath).toBe(directory);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(fsSync.fstatSync(fd).isFile()).toBe(true);
          if (outcome !== "success") {
            await fs.rename(target, path.join(directory, "published"));
            await fs.writeFile(target, "substitute");
            throw failure;
          }
        },
      });
      if (outcome === "success") await expect(pending).resolves.toHaveProperty("ino");
      else await expect(pending).rejects.toBe(failure);
      expect(() => fsSync.fstatSync(retainedFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
      const published = outcome === "success" ? target : path.join(directory, "published");
      expect((await fs.stat(published)).mode & 0o777).toBe(0);
      await fs.chmod(published, 0o600);
      expect(await fs.readFile(published, "utf8")).toBe("payload");
      if (outcome !== "success") expect(await fs.readFile(target, "utf8")).toBe("substitute");
    },
  );
});
