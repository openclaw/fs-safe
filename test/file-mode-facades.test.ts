import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { fileStore, fileStoreSync } from "../src/store.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-mode-facade-");
  const rootDir = path.join(directory, "root");
  const source = path.join(directory, "source");
  await fs.mkdir(rootDir, { mode: 0o700 });
  await fs.writeFile(source, "synthetic facade", { mode: 0o600 });
  return { rootDir, source, target: path.join(rootDir, "target") };
}

for (const backend of ["off", "require"] as const) {
  describe.skipIf(process.platform === "win32" || (backend === "require" && !nativeAvailable))(
    `explicit file modes through ${backend} facades`,
    () => {
      it.each(["write", "create", "copyIn"].flatMap((operation) => [0o600, 0o4600].map((mode) => ({ operation, mode }))))(
        "Root.$operation preserves $mode",
        async ({ operation, mode }) => {
          configureFsSafeNative({ mode: backend });
          const { rootDir, source, target } = await fixture();
          const capability = await root(rootDir);
          if (operation === "copyIn") await capability.copyIn("target", source, { mode });
          else if (operation === "create") await capability.create("target", "synthetic facade", { mode });
          else await capability.write("target", "synthetic facade", { mode });
          expect((await fs.stat(target)).mode & 0o7777).toBe(mode);
          expect(await fs.readFile(target, "utf8")).toBe("synthetic facade");
        },
      );

      it.each([false, true].flatMap((privateMode) => ["write", "copyIn", "writeStream"].flatMap((operation) =>
        [0o600, 0o4600].map((mode) => ({ privateMode, operation, mode })),
      )))("FileStore.$operation preserves $mode (private=$privateMode)", async ({ privateMode, operation, mode }) => {
        configureFsSafeNative({ mode: backend });
        const { rootDir, source, target } = await fixture();
        const store = fileStore({ rootDir, private: privateMode, mode });
        if (operation === "copyIn") await store.copyIn("target", source);
        else if (operation === "writeStream") await store.writeStream("target", Readable.from(["synthetic ", "facade"]));
        else await store.write("target", "synthetic facade");
        expect((await fs.stat(target)).mode & 0o7777).toBe(mode);
        expect(await fs.readFile(target, "utf8")).toBe("synthetic facade");
      });
    },
  );
}

describe.skipIf(process.platform === "win32")("existing synchronous mode finalization", () => {
  it.each([false, true].flatMap((privateMode) => [0o600, 0o4600].map((mode) => ({ privateMode, mode }))))(
    "FileStoreSync preserves $mode (private=$privateMode)",
    async ({ privateMode, mode }) => {
      const { rootDir, target } = await fixture();
      fileStoreSync({ rootDir, private: privateMode, mode }).write("target", "synthetic facade");
      expect((await fs.stat(target)).mode & 0o7777).toBe(mode);
      expect(await fs.readFile(target, "utf8")).toBe("synthetic facade");
    },
  );
});
