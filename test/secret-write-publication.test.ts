import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import * as verification from "../src/root-write-verification.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const writers = [
  { operation: "write", write: writeSecretFileAtomic },
  { operation: "create", write: createSecretFileAtomic },
] as const;
const modes = [0o000, 0o200, 0o400, 0o600, 0o1600, 0o2600, 0o4600, 0o6600];
const verify = verification.verifyAtomicWriteResult;

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

for (const backend of ["off", "require"] as const) {
  describe.skipIf(process.platform === "win32" || (backend === "require" && !nativeAvailable))(
    `secret publication: native ${backend}`,
    () => {
      it.skipIf(process.getuid?.() === 0).each(writers.flatMap((writer) =>
        modes.map((mode) => ({ ...writer, mode })),
      ))("$operation preserves mode $mode without a readonly reopen", async ({ write, mode }) => {
        configureFsSafeNative({ mode: backend });
        expect(process.getuid?.()).toBeGreaterThan(0);
        const rootDir = await tempRoot("fs-safe-secret-mode-");
        await fs.chown(rootDir, process.geteuid!(), process.getegid!());
        const filePath = path.join(rootDir, "token");
        const content = Uint8Array.from([0, 10, 127, 128, 255]);
        const open = vi.spyOn(fs, "open");
        const openSync = vi.spyOn(fsSync, "openSync");

        await expect(write({ rootDir, filePath, content, mode })).resolves.toBeUndefined();

        const isReadonly = (flags: string | number) => typeof flags === "string"
          ? flags === "r" || flags === "rs"
          : (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0;
        for (const calls of [open.mock.calls, openSync.mock.calls]) {
          expect(calls.filter(([candidate, flags]) =>
            String(candidate) === filePath && isReadonly(flags),
          )).toEqual([]);
        }
        vi.restoreAllMocks();
        const stat = await fs.lstat(filePath);
        expect(stat.isFile()).toBe(true);
        expect(stat.nlink).toBe(1);
        expect(stat.mode & 0o7777).toBe(mode);
        if ((mode & 0o400) === 0) {
          await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: "EACCES" });
        }
        // Inspect task-owned bytes only after proving the actual final permissions.
        await fs.chmod(filePath, 0o600);
        expect(await fs.readFile(filePath)).toEqual(Buffer.from(content));
        expect(await fs.readdir(rootDir)).toEqual(["token"]);
      });

      it.each(writers)("$operation defaults to 0600", async ({ write }) => {
        configureFsSafeNative({ mode: backend });
        const rootDir = await tempRoot("fs-safe-secret-default-");
        const filePath = path.join(rootDir, "token");
        await write({ rootDir, filePath, content: "synthetic default\n" });
        expect((await fs.stat(filePath)).mode & 0o7777).toBe(0o600);
        expect(await fs.readFile(filePath, "utf8")).toBe("synthetic default\n");
      });

      it.each(modes)("overwrites restrictive files and preserves create collisions at mode %i", async (mode) => {
        configureFsSafeNative({ mode: backend });
        const rootDir = await tempRoot("fs-safe-secret-overwrite-");
        await fs.chown(rootDir, process.geteuid!(), process.getegid!());
        const filePath = path.join(rootDir, "token");
        await createSecretFileAtomic({ rootDir, filePath, content: "original", mode });
        const original = await fs.stat(filePath, { bigint: true });
        await expect(createSecretFileAtomic({ rootDir, filePath, content: "collision", mode: 0o600 }))
          .rejects.toMatchObject({ code: "secret-exists" });
        const collided = await fs.stat(filePath, { bigint: true });
        expect(collided.ino).toBe(original.ino);
        expect(collided.mode & 0o7777n).toBe(BigInt(mode));
        await fs.chmod(filePath, 0o600);
        expect(await fs.readFile(filePath, "utf8")).toBe("original");
        await fs.chmod(filePath, mode);
        await writeSecretFileAtomic({ rootDir, filePath, content: "overwritten", mode });
        const overwritten = await fs.stat(filePath, { bigint: true });
        expect(overwritten.ino).not.toBe(original.ino);
        expect(overwritten.mode & 0o7777n).toBe(BigInt(mode));
        await fs.chmod(filePath, 0o600);
        expect(await fs.readFile(filePath, "utf8")).toBe("overwritten");
        expect(await fs.readdir(rootDir)).toEqual(["token"]);
      });

      it.each(writers.flatMap((writer) => [0o1000, 0o2000, 0o4000].map((extra) => ({ ...writer, extra }))))(
        "$operation rejects unexpected special mode bits $extra after publication",
        async ({ write, extra }) => {
          configureFsSafeNative({ mode: backend });
          const rootDir = await tempRoot("fs-safe-secret-extra-mode-");
          await fs.chown(rootDir, process.geteuid!(), process.getegid!());
          const filePath = path.join(rootDir, "token");
          const checked = vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
            fsSync.fchmodSync(params.fd, 0o600 | extra);
            await verify(params);
          });
          await expect(write({ rootDir, filePath, content: "synthetic", mode: 0o600 }))
            .rejects.toThrow(/insecure permissions/);
          expect(checked).toHaveBeenCalledOnce();
          expect((await fs.stat(filePath)).mode & 0o7777).toBe(0o600 | extra);
          expect(await fs.readFile(filePath, "utf8")).toBe("synthetic");
        },
      );

      const attacks = [
        "none", "same bytes", "symlink", "hardlink replacement", "late hardlink",
        "parent swap", "root swap", "parent rebind", "root rebind", "callback failure", "I/O failure", "late mode",
      ] as const;
      it.each(writers.flatMap((writer) => attacks.map((attack) => ({ ...writer, attack }))))(
        "$operation retains ownership through $attack verification",
        async ({ write, attack }) => {
          configureFsSafeNative({ mode: backend });
          const sandbox = await tempRoot("fs-safe-secret-publication-");
          const rootDir = path.join(sandbox, "root");
          const parent = path.join(rootDir, "parent");
          const outside = path.join(sandbox, "outside");
          const filePath = path.join(parent, "token");
          await fs.mkdir(parent, { recursive: true, mode: 0o700 });
          await fs.mkdir(outside);
          const outsideFile = path.join(outside, "untouched");
          await fs.writeFile(outsideFile, "outside", { mode: 0o600 });
          const payload = "synthetic published bytes";
          const sentinel = Object.assign(new Error("verification failed"), { code: "EIO" });
          let borrowedFd: number | undefined;
          let publishedPath = filePath;
          let injected = false;
          const handles: Array<{ fd: number; close: ReturnType<typeof vi.spyOn> }> = [];
          const open = fs.open.bind(fs);
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            handles.push({ fd: handle.fd, close: vi.spyOn(handle, "close") });
            return handle;
          });
          const closeSync = vi.spyOn(fsSync, "closeSync");
          const checked = vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
            borrowedFd = params.fd;
            const stat = fsSync.fstatSync(params.fd, { bigint: true });
            expect(params.expectedIdentity).toMatchObject({ dev: stat.dev, ino: stat.ino });
            expect(stat.mode & 0o7777n).toBe(0n);
            if (["same bytes", "symlink", "hardlink replacement"].includes(attack)) {
              publishedPath = path.join(parent, "published");
              await fs.rename(filePath, publishedPath);
              if (attack === "symlink") await fs.symlink(outsideFile, filePath);
              else if (attack === "hardlink replacement") await fs.link(outsideFile, filePath);
              else await fs.writeFile(filePath, payload, { mode: 0o400 });
              injected = true;
            } else if (attack.startsWith("parent") || attack.startsWith("root")) {
              const moved = path.join(outside, "moved");
              const swapped = attack.startsWith("parent") ? parent : rootDir;
              await fs.rename(swapped, moved);
              publishedPath = path.join(moved, attack.startsWith("parent") ? "token" : "parent/token");
              if (attack.endsWith("swap")) {
                await fs.symlink(moved, swapped, "dir");
              } else {
                await fs.mkdir(swapped);
                await fs.rename(attack.startsWith("parent") ? publishedPath : path.join(moved, "parent"),
                  attack.startsWith("parent") ? filePath : parent);
                publishedPath = filePath;
              }
              injected = true;
            } else if (attack === "callback failure") {
              injected = true;
              throw sentinel;
            } else if (attack === "I/O failure" || attack === "late hardlink" || attack === "late mode") {
              const lstat = fs.lstat.bind(fs);
              vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
                if (attack === "I/O failure" && String(args[0]) === filePath) {
                  injected = true;
                  throw sentinel;
                }
                // Run after the first file check, during ancestry validation.
                if (!injected && String(args[0]) === parent) {
                  injected = true;
                  if (attack === "late hardlink") await fs.link(filePath, path.join(parent, "alias"));
                  else fsSync.fchmodSync(params.fd, 0o644);
                }
                return await lstat(...args);
              }) as typeof fs.lstat);
            }
            try {
              await verify(params);
            } finally {
              // The verifier borrows; success and failure both leave closing to the writer.
              expect(fsSync.fstatSync(params.fd).isFile()).toBe(true);
            }
          });
          const pending = write({ rootDir, filePath, content: payload, mode: 0o000 });
          if (attack === "none") await expect(pending).resolves.toBeUndefined();
          else if (attack.endsWith("failure")) await expect(pending).rejects.toBe(sentinel);
          else if (attack === "late mode") await expect(pending).rejects.toThrow("has insecure permissions 644");
          else {
            const error = await pending.catch((error: unknown) => error);
            expect(error).toMatchObject({ code: attack === "symlink" ? "symlink"
              : attack === "late hardlink" ? "hardlink"
                : attack.endsWith("swap") ? "outside-workspace" : "path-mismatch" });
          }
          expect(checked).toHaveBeenCalledTimes(1);
          expect(injected).toBe(attack !== "none");
          expect(borrowedFd).toBeTypeOf("number");
          expect(() => fsSync.fstatSync(borrowedFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
          const closes = closeSync.mock.calls.filter(([fd]) => fd === borrowedFd).length
            + handles.filter(({ fd }) => fd === borrowedFd).reduce((sum, { close }) => sum + close.mock.calls.length, 0);
          expect(closes).toBe(1);
          vi.restoreAllMocks();
          expect((await fs.stat(publishedPath)).mode & 0o7777).toBe(attack === "late mode" ? 0o644 : 0o000);
          await fs.chmod(publishedPath, 0o600);
          expect(await fs.readFile(publishedPath, "utf8")).toBe(payload);
          expect(await fs.readFile(outsideFile, "utf8")).toBe("outside");
          expect((await fs.stat(outsideFile)).mode & 0o7777).toBe(0o600);
          if (attack === "same bytes") {
            expect((await fs.stat(filePath)).mode & 0o7777).toBe(0o400);
            expect(await fs.readFile(filePath, "utf8")).toBe(payload);
          } else if (attack === "symlink") expect((await fs.lstat(filePath)).isSymbolicLink()).toBe(true);
          else if (attack === "hardlink replacement") {
            expect((await fs.stat(filePath)).ino).toBe((await fs.stat(outsideFile)).ino);
            expect(await fs.readFile(filePath, "utf8")).toBe("outside");
          }
          expect((await fs.readdir(sandbox, { recursive: true })).filter((entry) => entry.endsWith(".tmp")))
            .toEqual([]);
        },
      );
    },
  );
}
