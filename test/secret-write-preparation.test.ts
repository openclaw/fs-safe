import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { runOwnedPinnedWrite } from "../src/pinned-write.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const writers = [
  { operation: "write", write: writeSecretFileAtomic },
  { operation: "create", write: createSecretFileAtomic },
] as const;
let nativeAvailable = false;
try { __loadBundledNativeForTest(); nativeAvailable = true; }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

function observeFiles(
  backend: "off" | "require",
  rootDir: string,
  fault: "ignored-mode" | "replacement" | "none",
) {
  const opened = new Map<number, { pathname: string; close: number }>();
  const writes = vi.fn();
  const chmod = fsSync.fchmodSync.bind(fsSync);
  const inject = (fd: number) => {
    const owned = opened.get(fd)!;
    if (fault !== "none") {
      if (fault === "replacement") {
        fsSync.renameSync(owned.pathname, path.join(rootDir, "owned-empty"));
        fsSync.writeFileSync(owned.pathname, "replacement", { mode: 0o600 });
      }
      return;
    }
    chmod(fd, 0o600);
  };
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!fsSync.fstatSync(handle.fd).isFile()) return handle;
    const record = { pathname: String(args[0]), close: 0 };
    opened.set(handle.fd, record);
    if (fault !== "none") chmod(handle.fd, 0o777);
    const changeMode = handle.chmod.bind(handle);
    vi.spyOn(handle, "chmod").mockImplementation(async (mode) => {
      if (fault === "none") return await changeMode(mode);
      inject(handle.fd);
    });
    const write = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementation((async (...args: Parameters<typeof handle.write>) => {
      writes();
      return await write(...args);
    }) as typeof handle.write);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      record.close += 1;
      await close();
    });
    return handle;
  });
  if (backend === "require") {
    const native = __loadBundledNativeForTest();
    __setNativeLoaderForTest(() => ({
      ...native,
      createStagedFile(parentFd, basename) {
        const fd = native.createStagedFile!(parentFd, basename);
        opened.set(fd, { pathname: path.join(rootDir, basename), close: 0 });
        if (fault !== "none") chmod(fd, 0o777);
        return fd;
      },
      closeOwnedFd(fd) {
        const record = opened.get(fd);
        if (record) record.close += 1;
        native.closeOwnedFd(fd);
      },
    }));
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
      if (opened.has(fd) && fault !== "none") inject(fd);
      else chmod(fd, mode);
    });
    const write = fsSync.write.bind(fsSync);
    vi.spyOn(fsSync, "write").mockImplementation(((...args: Parameters<typeof fsSync.write>) => {
      if (opened.has(args[0])) writes();
      return write(...args);
    }) as typeof fsSync.write);
  }
  return { opened, writes, chmod };
}

for (const backend of ["off", "require"] as const) {
  describe.skipIf(process.platform === "win32" || (backend === "require" && !nativeAvailable))(
    `secret pre-write mode: native ${backend}`,
    () => {
      it.each(writers.flatMap((writer) => ["ignored-mode", "replacement"].map((fault) => ({
        ...writer, fault: fault as "ignored-mode" | "replacement",
      }))))("$operation refuses $fault before writing payload", async ({ write, operation, fault }) => {
        configureFsSafeNative({ mode: backend });
        const rootDir = await tempRoot("fs-safe-secret-preparation-");
        await fs.chmod(rootDir, 0o755);
        const filePath = path.join(rootDir, "token");
        if (operation === "write") await fs.writeFile(filePath, "original", { mode: 0o600 });
        const original = operation === "write" ? await fs.stat(filePath, { bigint: true }) : undefined;
        const { opened, writes } = observeFiles(backend, rootDir, fault);

        const failure = await write({
          rootDir, filePath, content: "must stay unwritten", dirMode: 0o755, durable: false,
        }).then(() => undefined, (error: unknown) => error);

        expect(writes).not.toHaveBeenCalled();
        expect(failure).toMatchObject({ code: "insecure-permissions" });
        expect(opened.size).toBe(1);
        for (const [fd, record] of opened) {
          expect(record.close).toBe(1);
          expect(() => fsSync.fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
          if (fault === "replacement") {
            expect(await fs.readFile(record.pathname, "utf8")).toBe("replacement");
            expect((await fs.stat(path.join(rootDir, "owned-empty"))).size).toBe(0);
          } else await expect(fs.lstat(record.pathname)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (original) {
          expect(await fs.readFile(filePath, "utf8")).toBe("original");
          expect((await fs.stat(filePath, { bigint: true })).ino).toBe(original.ino);
        } else if (fault !== "replacement" || backend === "require") {
          await expect(fs.lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (fault === "ignored-mode") expect(await fs.readdir(rootDir)).toEqual(original ? ["token"] : []);
      });

      it.each(writers.flatMap((writer) => [0o000, 0o200, 0o600, 0o640, 0o2600, 0o4600].map((mode) => ({ ...writer, mode }))))(
        "$operation preserves requested mode $mode under a restrictive umask",
        async ({ write, mode }) => {
          configureFsSafeNative({ mode: backend });
          const rootDir = await tempRoot("fs-safe-secret-preparation-mode-");
          await fs.chown(rootDir, process.geteuid!(), process.getegid!());
          await fs.chmod(rootDir, 0o755);
          const filePath = path.join(rootDir, "token");
          const previousMask = process.umask(0o777);
          try {
            await write({ rootDir, filePath, content: "synthetic", dirMode: 0o755, mode, durable: false });
          } finally { process.umask(previousMask); }
          expect((await fs.stat(filePath)).mode & 0o7777).toBe(mode);
          await fs.chmod(filePath, 0o600);
          expect(await fs.readFile(filePath, "utf8")).toBe("synthetic");
        },
      );

      it.each([false, true])("does not consume a stream when preparation fails (overwrite=%s)", async (overwrite) => {
        configureFsSafeNative({ mode: backend });
        const rootPath = await tempRoot("fs-safe-secret-preparation-stream-");
        const { writes, opened } = observeFiles(backend, rootPath, "ignored-mode");
        const next = vi.fn(async () => ({ done: true as const, value: undefined }));
        const iterator = vi.fn(() => ({ next }));
        await expect(runOwnedPinnedWrite({
          rootPath, relativeParentPath: "", basename: "token", mkdir: false,
          mode: 0o600, verifyPosixMode: true, sync: false, overwrite,
          input: { kind: "stream", stream: { [Symbol.asyncIterator]: iterator } },
        })).rejects.toMatchObject({ code: "insecure-permissions" });
        expect(iterator).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
        expect(writes).not.toHaveBeenCalled();
        expect([...opened.values()].map((record) => record.close)).toEqual([1]);
        expect(await fs.readdir(rootPath)).toEqual([]);
      });

      it.each([false, true])("closes a producer that broadens the mode before yielding (overwrite=%s)", async (overwrite) => {
        configureFsSafeNative({ mode: backend });
        const rootPath = await tempRoot("fs-safe-secret-preparation-yield-");
        const { writes, opened, chmod } = observeFiles(backend, rootPath, "none");
        const settled = vi.fn();
        async function* payload() {
          try {
            const fd = [...opened.keys()][0]!;
            chmod(fd, 0o777);
            yield "must stay unwritten";
          } finally { settled(); }
        }
        await expect(runOwnedPinnedWrite({
          rootPath, relativeParentPath: "", basename: "token", mkdir: false,
          mode: 0o600, verifyPosixMode: true, sync: false, overwrite,
          input: { kind: "stream", stream: payload() },
        })).rejects.toMatchObject({ code: "insecure-permissions" });
        expect(settled).toHaveBeenCalledOnce();
        expect(writes).not.toHaveBeenCalled();
        expect([...opened.values()].map((record) => record.close)).toEqual([1]);
        expect(await fs.readdir(rootPath)).toEqual([]);
      });
    },
  );
}
