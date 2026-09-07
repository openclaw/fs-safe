import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, FsSafeError, root } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import * as verification from "../src/root-write-verification.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

const { tempRoot } = useRealTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const verifyPublished = verification.verifyAtomicWriteResult;
const payload = "published bytes";

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

const attacks = [
  "none", "same bytes", "different bytes", "symlink", "hardlink", "late hardlink",
  "parent escape", "parent rebind", "root escape", "root rebind", "EIO", "EACCES",
  "EPERM", "EEXIST",
] as const;
type Attack = typeof attacks[number];

for (const backend of ["javascript", "native", "windows fallback branch"] as const) {
  describe.skipIf(process.platform === "win32" || (backend === "native" && !nativeAvailable))(
    `Root retained publication descriptor: ${backend}`,
    () => {
      it.each([0o000, 0o600].flatMap((mode) =>
        ["write", "create"].flatMap((operation) =>
          attacks.map((attack) => ({ mode, operation, attack })),
        ),
      ))("$operation mode $mode: $attack", async ({ mode, operation, attack }) => {
        configureFsSafeNative({ mode: backend === "native" ? "require" : "off" });
        // Exercise the Windows Root branches with real descriptors, not Windows OS semantics.
        if (backend === "windows fallback branch") {
          Object.defineProperty(process, "platform", { value: "win32" });
        }
        const sandbox = await tempRoot("fs-safe-write-verification-");
        const workspace = path.join(sandbox, "workspace");
        const parent = path.join(workspace, "parent");
        const outside = path.join(sandbox, "outside");
        const target = path.join(parent, "target");
        const outsideFile = path.join(outside, "untouched");
        await fs.mkdir(parent, { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(outsideFile, "outside bytes");
        if (operation === "write") await fs.writeFile(target, "old bytes");
        const safe = await root(workspace);
        const sentinel = Object.assign(new Error("post-publication I/O failure"), { code: attack });
        let retainedFd: number | undefined;
        let publishedPath = target;
        let injected = false;
        const realLstat = fsSync.lstatSync.bind(fsSync);
        const inject = (kind: Attack) => {
          injected = true;
          if (kind === "same bytes" || kind === "different bytes" || kind === "symlink") {
            publishedPath = path.join(parent, "original");
            fsSync.renameSync(target, publishedPath);
            if (kind === "symlink") {
              fsSync.symlinkSync(outsideFile, target);
            } else {
              fsSync.writeFileSync(target, kind === "same bytes" ? payload : "raced bytes", { mode });
            }
          } else if (kind === "hardlink" || kind === "late hardlink") {
            fsSync.linkSync(target, path.join(parent, "alias"));
          } else if (kind === "parent escape" || kind === "parent rebind") {
            const moved = path.join(outside, "moved-parent");
            fsSync.renameSync(parent, moved);
            publishedPath = path.join(moved, "target");
            if (kind === "parent escape") {
              fsSync.symlinkSync(moved, parent);
            } else {
              fsSync.mkdirSync(parent);
              fsSync.renameSync(publishedPath, target);
              publishedPath = target;
            }
          } else if (kind === "root escape" || kind === "root rebind") {
            const moved = path.join(outside, "moved-root");
            fsSync.renameSync(workspace, moved);
            publishedPath = path.join(moved, "parent", "target");
            if (kind === "root escape") {
              fsSync.symlinkSync(moved, workspace);
            } else {
              fsSync.mkdirSync(workspace);
              fsSync.renameSync(path.join(moved, "parent"), parent);
              publishedPath = target;
            }
          }
        };
        const verifier = vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
          retainedFd = params.fd;
          expect(fsSync.fstatSync(params.fd).mode & 0o777).toBe(mode);
          expect(fsSync.fstatSync(params.fd).isFile()).toBe(true);
          if (attack === "late hardlink") {
            // Add a link after canonical resolution, while checking the parent.
            vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
              if (!injected && String(args[0]) === parent) inject(attack);
              return realLstat(...args);
            }) as typeof fsSync.lstatSync);
          } else if (["EIO", "EACCES", "EPERM", "EEXIST"].includes(attack)) {
            vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
              if (String(args[0]) === target) {
                injected = true;
                throw sentinel;
              }
              return realLstat(...args);
            }) as typeof fsSync.lstatSync);
          } else {
            await inject(attack);
          }
          return await verifyPublished(params);
        });

        const pending = operation === "create"
          ? safe.create("parent/target", payload, { mode })
          : safe.write("parent/target", payload, { mode });
        if (attack === "none") {
          await expect(pending).resolves.toBeUndefined();
        } else if (["EIO", "EACCES", "EPERM", "EEXIST"].includes(attack)) {
          await expect(pending).rejects.toBe(sentinel);
        } else {
          const error = await pending.catch((error: unknown) => error);
          expect(error).toBeInstanceOf(FsSafeError);
          const acceptable = attack === "symlink" ? ["symlink"]
            : attack.includes("hardlink") ? ["hardlink"]
            : attack.includes("escape") ? ["outside-workspace", "path-mismatch", "symlink"]
            : ["path-mismatch"];
          expect(acceptable).toContain((error as FsSafeError).code);
        }
        expect(verifier).toHaveBeenCalledTimes(1);
        expect(injected).toBe(true);
        expect(retainedFd).toBeTypeOf("number");
        expect(() => fsSync.fstatSync(retainedFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
        vi.restoreAllMocks();

        expect((await fs.lstat(publishedPath)).mode & 0o777).toBe(mode);
        await fs.chmod(publishedPath, 0o600);
        expect(await fs.readFile(publishedPath, "utf8")).toBe(payload);
        expect(await fs.readFile(outsideFile, "utf8")).toBe("outside bytes");
        if (attack === "same bytes" || attack === "different bytes") {
          expect((await fs.lstat(target)).mode & 0o777).toBe(mode);
          await fs.chmod(target, 0o600);
          expect(await fs.readFile(target, "utf8")).toBe(attack === "same bytes" ? payload : "raced bytes");
        }
        if (attack === "symlink") expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
        expect((await fs.readdir(sandbox, { recursive: true })).filter((entry) =>
          entry.endsWith(".tmp") || entry.endsWith(".lock"),
        )).toEqual([]);
      });
    },
  );
}
