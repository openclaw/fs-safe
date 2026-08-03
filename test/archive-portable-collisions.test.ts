import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  block.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarFixture(paths: string[]): Buffer {
  const blocks: Buffer[] = [];
  for (const [index, entryPath] of paths.entries()) {
    const body = Buffer.from(index === 0 ? "first" : "second");
    const header = Buffer.alloc(512);
    header.write(entryPath, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
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
    await fs.writeFile(archivePath, tarFixture([firstName, secondName]));
    await fs.mkdir(destDir);

    await expect(
      extractArchive({ archivePath, destDir, kind: "tar", timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
  });
});
