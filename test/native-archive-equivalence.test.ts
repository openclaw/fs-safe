import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectFsSafeErrorSync } from "./helpers/security.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  extractArchive,
  readArchiveEntry,
  resolveArchiveKind,
  ArchiveFormatError,
  ArchiveLimitError,
} from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __loadBundledNativeForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // JS-only jobs intentionally exercise the fallback without a built binding.
}
const tempDirs: string[] = [];

type TarFixtureEntry = {
  path: string;
  body?: string;
  mode?: number;
  type?: "0" | "1" | "2" | "5" | "7" | "K" | "L" | "S" | "g" | "x";
  linkPath?: string;
  base256Size?: number;
};

function writeString(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarFixture(entries: TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const fixture of entries) {
    const body = Buffer.from(fixture.body ?? "");
    const type = fixture.type ?? "0";
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, fixture.path);
    writeOctal(header, 100, 8, fixture.mode ?? (type === "5" ? 0o755 : 0o644));
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    const hasBody =
      type === "0" ||
      type === "7" ||
      type === "K" ||
      type === "L" ||
      type === "g" ||
      type === "x";
    const size = fixture.base256Size ?? (hasBody ? body.length : 0);
    if (fixture.base256Size === undefined) {
      writeOctal(header, 124, 12, size);
    } else {
      header[124] = 0x80;
      header.writeBigUInt64BE(BigInt(size), 128);
    }
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, type);
    writeString(header, 157, 100, fixture.linkPath ?? "");
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);
    if (hasBody && fixture.base256Size === undefined) {
      blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-archive-"));
  tempDirs.push(root);
  return root;
}

function useBackend(backend: "native" | "javascript"): void {
  if (backend === "native") {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
  } else {
    configureFsSafeNative({ mode: "off" });
  }
}

async function settleWithin<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`archive rejection did not settle within ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

afterEach(async () => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  await Promise.all(tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const archiveBackends = native
  ? (["native", "javascript"] as const)
  : (["javascript"] as const);

describe.each(archiveBackends)("%s archive path", (backend) => {
  it("extracts and reads the same clamped regular file", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "fixture.tar");
    const destination = path.join(root, "destination");
    await fs.writeFile(archivePath, tarFixture([{ path: "bin/tool", body: "payload", mode: 0o7777 }]));
    await fs.mkdir(destination);

    await extractArchive({ archivePath, destDir: destination, timeoutMs: 10_000 });
    await expect(fs.readFile(path.join(destination, "bin", "tool"), "utf8")).resolves.toBe("payload");
    await expect(readArchiveEntry(archivePath, "bin/tool", { maxBytes: 7 })).resolves.toEqual(Buffer.from("payload"));
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(destination, "bin", "tool"))).mode & 0o7777).toBe(0o755);
    }
  });

  it("normalizes a dot-prefixed TAR member for bounded reads", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "dot-path.tar");
    await fs.writeFile(archivePath, tarFixture([{ path: "./value.txt", body: "value" }]));
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 })).resolves.toEqual(
      Buffer.from("value"),
    );
  });

  it("rejects traversal, symbolic links, and hard links", async () => {
    useBackend(backend);
    for (const [name, entry] of [
      ["traversal", { path: "../escape", body: "owned" }],
      ["symlink", { path: "link", type: "2" as const, linkPath: "../escape" }],
      ["hardlink", { path: "link", type: "1" as const, linkPath: "target" }],
    ] as const) {
      const root = await tempRoot();
      const archivePath = path.join(root, `${name}.tar`);
      const destination = path.join(root, "destination");
      await fs.writeFile(archivePath, tarFixture([entry]));
      await fs.mkdir(destination);
      await expect(
        extractArchive({ archivePath, destDir: destination, timeoutMs: 10_000 }),
      ).rejects.toBeTruthy();
      await expect(fs.readdir(destination)).resolves.toEqual([]);
    }
  });

  it("settles every TAR policy rejection without leaving the parser paused", async () => {
    useBackend(backend);
    const cases = [
      {
        name: "filtered-symlink",
        entry: { path: "fleet/link", type: "2" as const, linkPath: "../outside" },
        options: {
          entryFilter: (entry: { kind: string }) =>
            entry.kind === "symlink" ? ("skip" as const) : ("extract" as const),
        },
        expected: { name: "ArchiveSecurityError", code: "entry-filtered" },
      },
      {
        name: "blocked-symlink",
        entry: { path: "fleet/link", type: "2" as const, linkPath: "../outside" },
        options: {},
        expected: { name: "ArchiveSecurityError", code: "entry-link" },
      },
      {
        name: "traversal",
        entry: { path: "../outside", body: "owned" },
        options: {},
        expected: { name: "ArchiveSecurityError", code: "entry-path" },
      },
      {
        name: "entry-limit",
        entry: { path: "oversized", body: "too large" },
        options: { limits: { maxEntryBytes: 1 } },
        expected: { code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT },
      },
    ];

    for (const fixture of cases) {
      const root = await tempRoot();
      const archivePath = path.join(root, `${fixture.name}.tar`);
      const destination = path.join(root, "destination");
      await fs.writeFile(archivePath, tarFixture([fixture.entry]));
      await fs.mkdir(destination);

      await expect(
        settleWithin(
          extractArchive({
            archivePath,
            destDir: destination,
            timeoutMs: 10_000,
            ...fixture.options,
          }),
        ),
      ).rejects.toMatchObject(fixture.expected);
      await expect(fs.readdir(destination)).resolves.toEqual([]);
    }
  });

  it("enforces entry-count, per-entry, and total byte budgets", async () => {
    useBackend(backend);
    const fixture = tarFixture([
      { path: "one", body: "1234" },
      { path: "two", body: "5678" },
    ]);
    for (const [limits, code] of [
      [{ maxEntries: 1 }, ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT],
      [{ maxEntryBytes: 3 }, ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT],
      [{ maxExtractedBytes: 7 }, ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT],
    ] as const) {
      const root = await tempRoot();
      const archivePath = path.join(root, "limits.tar");
      const destination = path.join(root, "destination");
      await fs.writeFile(archivePath, fixture);
      await fs.mkdir(destination);
      await expect(
        extractArchive({ archivePath, destDir: destination, timeoutMs: 10_000, limits }),
      ).rejects.toMatchObject({ code });
      await expect(fs.readdir(destination)).resolves.toEqual([]);
    }
  });

  it("counts entries removed by stripComponents against maxEntries", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "stripped-entry-limit.tar");
    const destination = path.join(root, "destination");
    await fs.writeFile(
      archivePath,
      tarFixture([
        { path: "one", body: "1" },
        { path: "two", body: "2" },
      ]),
    );
    await fs.mkdir(destination);

    await expect(
      extractArchive({
        archivePath,
        destDir: destination,
        timeoutMs: 10_000,
        stripComponents: 1,
        limits: { maxEntries: 1 },
      }),
    ).rejects.toMatchObject({ code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT });
    await expect(fs.readdir(destination)).resolves.toEqual([]);
  });

  it("rejects entries that collide after stripComponents", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "stripped-collision.tar");
    const destination = path.join(root, "destination");
    await fs.writeFile(
      archivePath,
      tarFixture([
        { path: "one/value.txt", body: "first" },
        { path: "two/value.txt", body: "second" },
      ]),
    );
    await fs.mkdir(destination);

    await expect(
      extractArchive({
        archivePath,
        destDir: destination,
        timeoutMs: 10_000,
        stripComponents: 1,
      }),
    ).rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    await expect(fs.readdir(destination)).resolves.toEqual([]);
  });

  it("rejects duplicate TAR names during bounded reads", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "duplicate-read.tar");
    await fs.writeFile(
      archivePath,
      tarFixture([
        { path: "value.txt", body: "first" },
        { path: "value.txt", body: "second" },
      ]),
    );

    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 16 }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
  });

  it("rejects deep entry paths before creating implicit directories", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "deep-path.tar");
    const destination = path.join(root, "destination");
    await fs.writeFile(
      archivePath,
      tarFixture([{ path: "one/two/three/four/value.txt", body: "payload" }]),
    );
    await fs.mkdir(destination);

    await expect(
      extractArchive({
        archivePath,
        destDir: destination,
        timeoutMs: 10_000,
        limits: { maxEntryPathComponents: 4 },
      }),
    ).rejects.toMatchObject({
      code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT,
    });
    await expect(fs.readdir(destination)).resolves.toEqual([]);
  });

  it("applies byte budgets after explicitly skipped entries", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "filtered-limits.tar");
    const destination = path.join(root, "destination");
    await fs.writeFile(
      archivePath,
      tarFixture([
        { path: "skip", body: "oversized" },
        { path: "keep", body: "k" },
      ]),
    );
    await fs.mkdir(destination);

    await extractArchive({
      archivePath,
      destDir: destination,
      timeoutMs: 10_000,
      limits: { maxEntryBytes: 1, maxExtractedBytes: 1 },
      entryFilter: (entry) => (entry.path === "skip" ? "skip" : "extract"),
      onFiltered: "skip-entry",
    });
    await expect(fs.readFile(path.join(destination, "keep"), "utf8")).resolves.toBe("k");
  });

  it.each([
    ["oversized PAX", [{ path: "PaxHeader", type: "x" as const, body: "path=very-long-name\n" }]],
    [
      "oversized GNU longname",
      [{ path: "LongName", type: "L" as const, body: "this-name-is-definitely-long\0" }],
    ],
    [
      "chained metadata",
      [
        { path: "LongName", type: "L" as const, body: "short\0" },
        { path: "LongLink", type: "K" as const, body: "oversized-link-target\0" },
      ],
    ],
    [
      "base-256 metadata size",
      [{ path: "PaxHeader", type: "x" as const, base256Size: 17 }],
    ],
  ])("rejects %s before metadata buffering", async (_label, entries) => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "metadata.tar");
    const destination = path.join(root, "destination");
    await fs.writeFile(archivePath, tarFixture(entries));
    await fs.mkdir(destination);

    await expect(
      extractArchive({
        archivePath,
        destDir: destination,
        timeoutMs: 10_000,
        limits: { maxMetaEntryBytes: 16 },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ArchiveLimitError);
      expect(error).toMatchObject({
        code: ARCHIVE_LIMIT_ERROR_CODE.META_ENTRY_SIZE_EXCEEDS_LIMIT,
      });
      return true;
    });
    await expect(fs.readdir(destination)).resolves.toEqual([]);
  });

  it("rejects a truncated TAR header with the same typed format error", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "truncated.tar");
    const destination = path.join(root, "destination");
    const truncated = tarFixture([{ path: "value", body: "value" }]).subarray(0, 511);
    await fs.writeFile(archivePath, truncated);
    await fs.mkdir(destination);

    await expect(
      extractArchive({ archivePath, destDir: destination, timeoutMs: 10_000 }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ArchiveFormatError);
      expect(error).toMatchObject({ code: "archive-header-invalid" });
      return true;
    });
  });

  it.each([
    ["PAX size overrides", { path: "PaxHeader", type: "x" as const, body: "10 path=a\n" }],
    ["GNU sparse entries", { path: "sparse", type: "S" as const }],
  ])("rejects unmeterable %s with the same typed format error", async (_label, entry) => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "unmeterable.tar");
    const destination = path.join(root, "destination");
    await fs.writeFile(archivePath, tarFixture([entry]));
    await fs.mkdir(destination);

    await expect(
      extractArchive({ archivePath, destDir: destination, timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: "archive-header-invalid" });
  });

  it("treats contiguous entries as regular files", async () => {
    useBackend(backend);
    const root = await tempRoot();
    const archivePath = path.join(root, "contiguous.tar");
    const destination = path.join(root, "destination");
    await fs.writeFile(
      archivePath,
      tarFixture([{ path: "contiguous", type: "7", body: "payload" }]),
    );
    await fs.mkdir(destination);

    await extractArchive({ archivePath, destDir: destination, timeoutMs: 10_000 });
    await expect(fs.readFile(path.join(destination, "contiguous"), "utf8")).resolves.toBe(
      "payload",
    );
  });
});

describe.runIf(Boolean(native))("native-only compressed tar formats", () => {
  const fixtures = {
    "tar-bzip2": "QlpoOTFBWSZTWR7OLWUAAE57kNIABIBAA3+AAIBuZt/ABAAgCCAAciIT1MmhkDQNAaeSCVNTyKeU9Qaek8oB6h6grzvOX5w+ADqMF1cEAQkPSi8X9JSUNEAhmhZFEfFXVrk06WnAZd6xiqSZl1ns0+55YMXVrY+KHgFL4hZYy28xFJSAznPLVCPxdyRThQkB7OLWUA==",
    "tar-zstd": "KLUv/WQAB7UDADKFEReQpzpAWzCQC1aaeGamglLuJoOiujuRBIXgqmerYAic+geI7xfhq/ZgabX5RhoV9CE0pyAWcvBMbNvORGdM2h6bWMCbSocRAPGAHwKkUFkZAg5E65ccFUDlwxo5gAxqHgpO4NMsGGCrmDkAOXBuxdo3ASQjp+s0",
  } as const;

  for (const [kind, base64] of Object.entries(fixtures) as Array<[keyof typeof fixtures, string]>) {
    it(`extracts and reads ${kind}`, async () => {
      useBackend("native");
      const root = await tempRoot();
      const extension = kind === "tar-zstd" ? "tar.zst" : "tar.bz2";
      const archivePath = path.join(root, `fixture.${extension}`);
      const destination = path.join(root, "destination");
      await fs.writeFile(archivePath, Buffer.from(base64, "base64"));
      await fs.mkdir(destination);

      expect(resolveArchiveKind(archivePath)).toBe(kind);
      await extractArchive({ archivePath, destDir: destination, timeoutMs: 10_000 });
      await expect(fs.readFile(path.join(destination, "value.txt"), "utf8")).resolves.toBe("compressed-value");
      await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 16 })).resolves.toEqual(Buffer.from("compressed-value"));
    });
  }

  it("reports a typed actionable error when a native-only format is forced off", async () => {
    configureFsSafeNative({ mode: "off" });
    expectFsSafeErrorSync(() => resolveArchiveKind("fixture.tar.zst"), "helper-unavailable");
  });
});
