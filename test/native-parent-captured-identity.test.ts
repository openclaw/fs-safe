import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import * as staging from "../src/staged-directory.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
if (process.platform !== "win32" && !process.versions.bun) {
  try {
    native = __loadBundledNativeForTest();
  } catch (error) {
    if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

it.runIf(native !== undefined)(
  "rejects a parent name replaced after its descriptor receipt was accepted",
  async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-parent-captured-identity-");
    const parent = path.join(directory, "parent");
    const parked = path.join(directory, "original-parent");
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, "sentinel"), "original sentinel");
    const safe = await root(directory);
    const createStage = vi.fn(native!.createStagedFile!.bind(native));
    const actualClose = native!.closeOwnedFd!.bind(native);
    const closed: number[] = [];
    __setNativeLoaderForTest(() => ({
      ...native!,
      createStagedFile: createStage,
      closeOwnedFd(fd) {
        closed.push(fd);
        actualClose(fd);
      },
    }));
    const describe = staging.describeStagedDirectory;
    let retainedFd: number | undefined;
    let replaced = false;
    vi.spyOn(staging, "describeStagedDirectory").mockImplementation((fd, pathname) => {
      const receipt = describe(fd, pathname);
      if (!replaced && pathname === parent) {
        retainedFd = fd;
        // The real descriptor/name receipt succeeded. Only the pathname changes.
        fsSync.renameSync(parent, parked);
        fsSync.mkdirSync(parent);
        fsSync.writeFileSync(path.join(parent, "sentinel"), "replacement sentinel");
        replaced = true;
      }
      return receipt;
    });

    await expect(safe.write("./parent/value", "payload", {
      mkdir: false,
      durable: false,
      mutationSymlinks: "reject",
    })).rejects.toMatchObject({ code: "path-mismatch" });

    expect(replaced).toBe(true);
    expect(retainedFd).toBeDefined();
    expect(closed.filter(fd => fd === retainedFd)).toHaveLength(1);
    expect(() => fsSync.fstatSync(retainedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(createStage).not.toHaveBeenCalled();
    expect(await fs.readdir(parent)).toEqual(["sentinel"]);
    expect(await fs.readdir(parked)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(parent, "sentinel"), "utf8")).toBe("replacement sentinel");
    expect(await fs.readFile(path.join(parked, "sentinel"), "utf8")).toBe("original sentinel");
  },
);
