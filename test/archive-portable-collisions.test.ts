import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { extractArchive } from "../src/archive.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // JS-only jobs intentionally exercise the fallback without a built binding.
}

function useBackend(backend: "native" | "javascript"): void {
  if (backend === "native") {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
  } else {
    configureFsSafeNative({ mode: "off" });
  }
}

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

const backends = native ? (["native", "javascript"] as const) : (["javascript"] as const);

describe.each(backends)("%s portable archive collisions", (backend) => {
  it.each([
    ["case", "Payload.txt", "payload.txt"],
    ["Unicode normalization", "caf\u00e9.txt", "cafe\u0301.txt"],
  ])("rejects %s-equivalent TAR output names", async (_label, firstName, secondName) => {
    useBackend(backend);
    const root = await tempRoot("fs-safe-archive-portable-tar-");
    const archivePath = path.join(root, "payload.tar");
    const destDir = path.join(root, "dest");
    await fs.writeFile(archivePath, tarFixture([
      { path: firstName, body: "first" },
      { path: secondName, body: "second" },
    ]));
    await fs.mkdir(destDir);

    await expect(
      extractArchive({ archivePath, destDir, kind: "tar", timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
  });
});
