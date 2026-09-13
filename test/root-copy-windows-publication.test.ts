import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root, type RootCopyPublicationReceipt } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.skipIf(!native)("Root.copyIn Windows native publication", () => {
  it.each([false, true].flatMap(overwrite =>
    (["chmod", "sync"] as const).map(fault => ({ overwrite, fault }))))(
    "preserves the published copy after $fault fails (overwrite=$overwrite)",
    async ({ overwrite, fault }) => {
      // Exercise this writer with real descriptor operations on every native host;
      // Windows CI supplies the platform-specific binding and permission semantics.
      Object.defineProperty(process, "platform", { value: "win32" });
      configureFsSafeNative({ mode: "require" });
      const opened: number[] = [];
      __setNativeLoaderForTest(() => ({
        ...native!,
        openBeneath(...args) {
          const result = native!.openBeneath(...args);
          opened.push(result.fd);
          return result;
        },
      }));
      const directory = await tempRoot("fs-safe-copy-windows-publication-");
      const source = path.join(directory, "source");
      const target = path.join(directory, "target");
      await fs.writeFile(source, "complete source");
      if (overwrite) await fs.writeFile(target, "previous destination");
      const scoped = await root(directory);
      let admitted: FileHandle | undefined;
      __setFsSafeTestHooksForTest({
        afterOpen(candidate, handle) { if (candidate === source) admitted = handle; },
      });
      const close = vi.spyOn(fsSync, "closeSync");
      const failure = Object.assign(new Error(`published ${fault} failed`), { code: "EIO" });
      let receipt: RootCopyPublicationReceipt | undefined;
      const chmod = fsSync.fchmodSync.bind(fsSync);
      vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
        if (receipt && fault === "chmod") throw failure;
        chmod(fd, mode);
      });
      const sync = fsSync.fsyncSync.bind(fsSync);
      vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
        if (receipt && fault === "sync" && fsSync.fstatSync(fd).isFile()) throw failure;
        sync(fd);
      });

      await expect(scoped.copyIn("target", source, {
        overwrite,
        mode: 0o400,
        onDestinationPublished: value => { receipt = value; },
      })).rejects.toMatchObject({ cause: failure });

      expect(receipt).toBeDefined();
      expect(admitted?.fd).toBe(-1);
      for (const fd of opened) expect(close).toHaveBeenCalledWith(fd);
      const current = await fs.stat(target, { bigint: true });
      expect(receipt).toEqual({ path: target, dev: current.dev, ino: current.ino });
      expect(await fs.readFile(target, "utf8")).toBe("complete source");
      expect(await fs.readFile(source, "utf8")).toBe("complete source");
      expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
    },
  );
});
