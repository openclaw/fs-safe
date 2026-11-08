import fs from "node:fs";
import { expect, it } from "vitest";
import { __loadBundledNativeForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";
const { tempRoot } = useRealTempDirs();
let native: ReturnType<typeof __loadBundledNativeForTest>;
try { native = __loadBundledNativeForTest(); } catch { /* Addon is optional in JS-only lanes. */ }

it.runIf(Boolean(native) && (process.platform === "linux" || process.platform === "darwin"))(
  "probes the held parent filesystem and rejects invalid descriptors", async () => {
    expect(typeof native!.is9pFilesystem).toBe("function");
    const directory = await tempRoot("drvfs-native-");
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const magic = fs.statfsSync(directory, { bigint: true }).type;
      expect(native!.is9pFilesystem!(fd)).toBe(process.platform === "linux" && magic === 0x01021997n);
      expect(() => native!.is9pFilesystem!(-1)).toThrow();
    } finally { fs.closeSync(fd); }
  },
);
