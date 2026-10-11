import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { loadWindowsSimulationNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let native: NativeBinding | undefined;
try { native = loadWindowsSimulationNative(); } catch { /* Optional outside native CI. */ }
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  vi.restoreAllMocks();
});

describe.runIf(Boolean(native))("Windows publication metadata handles", () => {
  it.each([false, true])("uses a metadata reopen only without an authority callback (%s)", async callback => {
    Object.defineProperty(process, "platform", { value: "win32" });
    configureFsSafeNative({ mode: "require" });
    const metadata = vi.fn((fd: number, name: string) =>
      native!.openBeneath!(fd, name, fs.constants.O_RDONLY).fd);
    __setNativeLoaderForTest(() => ({ ...native!, openPublicationMetadata: metadata }));
    const directory = await tempRoot("fs-safe-publication-metadata-");
    const safe = await root(directory);
    await safe.create("target", "complete payload", {
      durable: false,
      ...(callback ? { assertBeforeMutation() {} } : {}),
    });
    expect(metadata).toHaveBeenCalledTimes(callback ? 0 : 1);
    expect(await fsAsync.readFile(path.join(directory, "target"), "utf8")).toBe("complete payload");
  });

  it.runIf(process.platform === "win32" && native?.openPublicationMetadata)(
    "supports identity and mode checks without granting file data access", async () => {
      const directory = await tempRoot("fs-safe-real-publication-metadata-");
      const file = path.join(directory, "target");
      await fsAsync.writeFile(file, "payload");
      const parent = fs.openSync(directory, fs.constants.O_RDONLY);
      const fd = native!.openPublicationMetadata!(parent, "target");
      try {
        expect(fs.fstatSync(fd).isFile()).toBe(true);
        fs.fchmodSync(fd, 0o600);
        expect(() => fs.readSync(fd, Buffer.alloc(1), 0, 1, 0)).toThrow();
      } finally {
        native!.closeOwnedFd!(fd);
        fs.closeSync(parent);
      }
      expect(await fsAsync.readFile(file, "utf8")).toBe("payload");
    },
  );
});
