import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { tempWorkspace } from "../src/temp.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native CI supplies the binding. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.runIf(native)("native temp creation", () => {
  for (const mode of ["require", "auto"] as const) {
    it(`creates a retained child without a pathname creation (${mode})`, async () => {
      const rootDir = await tempRoot("temp-native-create-");
      configureFsSafeNative({ mode });
      expect(native!.createTempDirectoryBeneath).toBeTypeOf("function");
      const create = vi.fn(native!.createTempDirectoryBeneath!.bind(native));
      __setNativeLoaderForTest(() => ({ ...native!, createTempDirectoryBeneath: create }));
      const asyncCreate = vi.spyOn(fsp, "mkdtemp");
      const syncCreate = vi.spyOn(fs, "mkdtempSync");
      const options = { rootDir, prefix: "workspace" };
      const workspace = await tempWorkspace(options);
      try {
        expect(create).toHaveBeenCalledTimes(1);
        expect(asyncCreate).not.toHaveBeenCalled();
        expect(syncCreate).not.toHaveBeenCalled();
        expect(path.dirname(workspace.dir)).toBe(rootDir);
        expect(fs.statSync(workspace.dir).isDirectory()).toBe(true);
      } finally { await workspace.cleanup(); }
    });
  }

  it("retries collisions without adopting or deleting the existing directory", async () => {
    const rootDir = await tempRoot("temp-native-collision-");
    configureFsSafeNative({ mode: "require" });
    let collision: string | undefined;
    const create = vi.fn((fd: number, name: string) => {
      if (!collision) {
        collision = path.join(rootDir, name);
        fs.mkdirSync(collision, { mode: 0o700 });
        fs.writeFileSync(path.join(collision, "preserved"), "original");
      }
      return native!.createTempDirectoryBeneath!(fd, name);
    });
    __setNativeLoaderForTest(() => ({ ...native!, createTempDirectoryBeneath: create }));
    const workspace = await tempWorkspace({ rootDir, prefix: "workspace" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(workspace.dir).not.toBe(collision);
    await workspace.cleanup();
    expect(fs.readFileSync(path.join(collision!, "preserved"), "utf8")).toBe("original");
  });

  it.runIf(process.platform !== "win32")("repairs a child created under an owner-read-masking umask", async () => {
    const rootDir = await tempRoot("temp-native-umask-");
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => ({ ...native!, createTempDirectoryBeneath(fd, name) {
      const previous = process.umask(0o400);
      try { return native!.createTempDirectoryBeneath!(fd, name); }
      finally { process.umask(previous); }
    } }));
    const workspace = await tempWorkspace({ rootDir, prefix: "workspace" });
    expect(fs.statSync(workspace.dir).mode & 0o777).toBe(0o700);
    expect(await workspace.cleanup()).toBe("removed");
  });

  it("closes the created handle and rejects a parent replacement before adoption", async () => {
    const base = await tempRoot("temp-native-parent-swap-");
    const rootDir = path.join(base, "root");
    const held = path.join(base, "held");
    fs.mkdirSync(rootDir, { mode: 0o700 });
    configureFsSafeNative({ mode: "require" });
    let childFd: number | undefined;
    __setNativeLoaderForTest(() => ({ ...native!, createTempDirectoryBeneath(fd, name) {
      fs.renameSync(rootDir, held);
      fs.mkdirSync(rootDir, { mode: 0o700 });
      const created = native!.createTempDirectoryBeneath!(fd, name);
      childFd = created.fd;
      return created;
    } }));
    await expect(tempWorkspace({ rootDir, prefix: "workspace" })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(fs.readdirSync(rootDir)).toEqual([]);
    expect(fs.readdirSync(held)).toHaveLength(1);
    expect(() => fs.fstatSync(childFd!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
  });
});
