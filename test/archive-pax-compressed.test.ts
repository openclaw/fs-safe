import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
// Synthetic USTAR: the 136-byte public provenance shape, path=renamed,
// size=700 over raw size=1, 700 'a' bytes, then sentinel='end'. No executable.
const fixtures = {
  "tar-bzip2": "QlpoOTFBWSZTWaPpgLYAAJZfiP3QQAF/4jpkeeJvZ9/RABAICDAA+bMGpTxMU0wQDTQAA9Roe1TQ0aaCtAKG0ag002pk00NGjCNMIaBhJJNGin6psmFP1Q0yAAAAA3qTZ7+bvz9zond5VIsZhIKcsoqSuFRKjFQVaC9kjTg8F9tb/eF1Zq4ocNNL/kxPYs6OzjIrlYAlFOSVrJB1qqOAAlKAZwiEwpnYdPKTH/RmVkEJhBgYbTZ0EIoqwOuOJAVvWdjy5QPNls7YWoU5xdRORENT+6EglKBSs5g4aPANgUbIKjVSCJrDLGJgkQ+9KKelZ76FwdhbIq73uwExwbhMnhpnBUDPaBcVVlRIqcokvrpgan2XrOrJSiUEJrZkPwi68xZ1qQx/i7kinChIUfTAWwA=",
  "tar-zstd": "KLUv/QRYzQcAwowrJDCHqg6gYBt7erELv4rtgRpeZX+V9VEVgMWTbbwCEBHVdliDBFHteIRKNnWVbm2L79iRmcD/wbb9lGkEyXIRtqgprm2ZxeXKJbA5El7CNgEWAygoEI9zKHDLbIp60GgmyLB4QM0z0DANVa7tYNjq9VRV/CgG9Oy9fD0Bg8c5EDSGB+Eo0mJckHkZlbcocEpJFQqZpqRLucufWb5W43IMzoTG/58z+X9mO+J2Lk4EGgCg5T84/jWNMaAS6G7A7AQE0/EBBQJQwIWrLhhQDehmgIwDIAKDaDikAFrCRRUQKya4OSoAwBAHq5hpQ2Xwc8MAx8plbgJIpiLRgA==",
} as const;

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.skipIf(!paxNative)("PAX compressed native mode=require", () => {
  beforeEach(() => {
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => paxNative!);
  });

  it.each(["tar-bzip2", "tar-zstd"] as const)("extracts and reads %s with effective budgets", async (kind) => {
    const root = await tempRoot("fs-safe-pax-compressed-");
    const archivePath = path.join(root, "fixture.bin");
    const destDir = path.join(root, "out");
    await fs.mkdir(destDir);
    await fs.writeFile(archivePath, Buffer.from(fixtures[kind], "base64"));
    await extractArchive({ archivePath, destDir, kind, timeoutMs: 10_000, limits: { maxMetaEntryBytes: 164, maxEntries: 2, maxEntryBytes: 700, maxExtractedBytes: 703 } });
    expect(await fs.readFile(path.join(destDir, "renamed"))).toEqual(Buffer.alloc(700, 0x61));
    expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("end");
    expect(await readArchiveEntry(archivePath, "renamed", { kind, maxBytes: 700 })).toEqual(Buffer.alloc(700, 0x61));
    expect(await readArchiveEntry(archivePath, "sentinel", { kind, maxBytes: 3 })).toEqual(Buffer.from("end"));
    await expect(readArchiveEntry(archivePath, "renamed", { kind, maxBytes: 699 })).rejects.toMatchObject({ code: "archive-entry-extracted-size-exceeds-limit" });
    for (const [limits, code] of [
      [{ maxMetaEntryBytes: 163 }, "archive-meta-entry-size-exceeds-limit"],
      [{ maxEntryBytes: 699 }, "archive-entry-extracted-size-exceeds-limit"],
    ] as const) {
      const rejectedDir = await fs.mkdtemp(path.join(root, "rejected-"));
      await expect(extractArchive({ archivePath, destDir: rejectedDir, kind, timeoutMs: 10_000, limits })).rejects.toMatchObject({ code });
      expect(await fs.readdir(rejectedDir)).toEqual([]);
    }
  });
});
