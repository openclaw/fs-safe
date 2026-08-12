import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  createPipelineTimeoutError,
  waitForDeadline,
  withExtractionDeadline,
  type ExtractionDeadline,
} from "../src/archive-deadline.js";
import { writeFileHandleFully } from "../src/archive-input.js";
import { stageArchiveFileForExtraction } from "../src/archive-input.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { archiveEntryKindFromTarType, resolveArchiveEntryMode } from "../src/archive-policy.js";
import { readZipCentralDirectoryEntryCount } from "../src/archive-zip-preflight.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

function deadline(): ExtractionDeadline {
  return {
    signal: new AbortController().signal,
    check: vi.fn(),
    dispose: vi.fn(),
  };
}

function zip64Fixture(totalEntries: bigint): Buffer {
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(totalEntries, 32);
  zip64.writeBigUInt64LE(0n, 40);
  zip64.writeBigUInt64LE(76n, 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(0n, 8);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([zip64, locator, eocd]);
}

function malformedCentralDirectory(params: {
  bytes: number;
  signature?: number;
  nameLength?: number;
}): Buffer {
  const central = Buffer.alloc(params.bytes);
  if (params.signature !== undefined && central.length >= 4) {
    central.writeUInt32LE(params.signature, 0);
  }
  if (params.nameLength !== undefined && central.length >= 30) {
    central.writeUInt16LE(params.nameLength, 28);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([central, eocd]);
}

describe("archive deadline edge cases", () => {
  it("supports disabled deadlines without installing a timer", async () => {
    await expect(withExtractionDeadline(0, "disabled", async (value) => {
      value.check();
      expect(value.signal.aborted).toBe(false);
      return "done";
    })).resolves.toBe("done");
    await expect(withExtractionDeadline(Number.POSITIVE_INFINITY, "disabled", async () => "done"))
      .resolves.toBe("done");
  });

  it("rejects immediately when handed an already-aborted deadline", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline elapsed");
    controller.abort(reason);
    const value = { signal: controller.signal, check: vi.fn(), dispose: vi.fn() };

    await expect(waitForDeadline(Promise.resolve("late"), value)).rejects.toBe(reason);
    expect(value.check).toHaveBeenCalledTimes(1);
  });

  it("maps only abort-shaped pipeline failures to the deadline reason", () => {
    const controller = new AbortController();
    const reason = new Error("extract timed out");
    controller.abort(reason);
    const value = { signal: controller.signal, check: vi.fn(), dispose: vi.fn() };
    const abort = Object.assign(new Error("other text"), { name: "AbortError" });
    const nodeAbort = new Error("The operation was aborted");
    const ordinary = new Error("corrupt archive");

    expect(createPipelineTimeoutError(abort, value)).toBe(reason);
    expect(createPipelineTimeoutError(nodeAbort, value)).toBe(reason);
    expect(createPipelineTimeoutError(ordinary, value)).toBe(ordinary);
  });
});

describe("archive input staging failures", () => {
  it("rejects non-files and inputs already over the archive limit", async () => {
    const root = await tempRoot("fs-safe-stage-input-");
    const directory = path.join(root, "directory");
    const oversized = path.join(root, "oversized");
    await fs.mkdir(directory);
    await fs.writeFile(oversized, "1234");
    const limits = resolveExtractLimits({ maxArchiveBytes: 3 });

    await expect(stageArchiveFileForExtraction({ archivePath: directory, limits, deadline: deadline() }))
      .rejects.toThrow("archive is not a regular file");
    await expect(stageArchiveFileForExtraction({ archivePath: oversized, limits, deadline: deadline() }))
      .rejects.toMatchObject({ code: "archive-size-exceeds-limit" });
  });

  itPosix("rejects symlink archive inputs", async () => {
    const root = await tempRoot("fs-safe-stage-link-");
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await fs.writeFile(target, "data");
    await fs.symlink(target, link);

    await expect(stageArchiveFileForExtraction({
      archivePath: link,
      limits: resolveExtractLimits(),
      deadline: deadline(),
    })).rejects.toThrow("archive is not a regular file");
  });

  it("rejects an archive whose identity changes after open", async () => {
    const root = await tempRoot("fs-safe-stage-race-");
    const archivePath = path.join(root, "archive");
    await fs.writeFile(archivePath, "archive");
    const realLstat = fs.lstat.bind(fs);
    const originalStat = await realLstat(archivePath);
    const changedStat = new Proxy(originalStat, {
      get(target, property) {
        if (property === "ino") {
          // Keep the swapped identity nonzero: zero win32 inodes are "unknown identity" by
          // design, and float precision makes `+ 1` a no-op for indexes above 2^53.
          return typeof target.ino === "bigint" ? target.ino + 1n : target.ino === 12345 ? 54321 : 12345;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let archiveLstats = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate) => {
      if (String(candidate) === archivePath && ++archiveLstats === 2) return changedStat;
      return await realLstat(candidate);
    });

    await expect(stageArchiveFileForExtraction({
      archivePath,
      limits: resolveExtractLimits(),
      deadline: deadline(),
    })).rejects.toThrow("archive changed during validation");
    expect(archiveLstats).toBe(2);
  });

  it("enforces the byte limit if a pinned input grows after its initial stat", async () => {
    const root = await tempRoot("fs-safe-stage-growth-");
    const archivePath = path.join(root, "archive");
    await fs.writeFile(archivePath, "123");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) !== archivePath) return handle;
      let read = false;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return async (buffer: Buffer) => {
              if (read) return { bytesRead: 0, buffer };
              read = true;
              buffer.write("1234");
              return { bytesRead: 4, buffer };
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FileHandle;
    });

    await expect(stageArchiveFileForExtraction({
      archivePath,
      limits: resolveExtractLimits({ maxArchiveBytes: 3 }),
      deadline: deadline(),
    })).rejects.toMatchObject({ code: "archive-size-exceeds-limit" });
  });

  it("writes short chunks fully and rejects a writer that makes no progress", async () => {
    const checks = vi.fn();
    let writes = 0;
    const shortWriter = {
      async write() {
        writes += 1;
        return { bytesWritten: 1 };
      },
    } as unknown as FileHandle;
    await writeFileHandleFully({
      handle: shortWriter,
      buffer: Buffer.from("abc"),
      bytes: 3,
      deadline: { ...deadline(), check: checks },
    });
    expect(writes).toBe(3);
    expect(checks).toHaveBeenCalledTimes(3);

    const stalled = { async write() { return { bytesWritten: 0 }; } } as unknown as FileHandle;
    await expect(writeFileHandleFully({
      handle: stalled,
      buffer: Buffer.from("x"),
      bytes: 1,
      deadline: deadline(),
    })).rejects.toThrow("archive staging write made no progress");
  });
});

describe("malformed ZIP central directories", () => {
  it("parses ZIP64 counts and clamps integers beyond JavaScript's safe range", () => {
    expect(readZipCentralDirectoryEntryCount(zip64Fixture(0n))).toBe(0);
    expect(readZipCentralDirectoryEntryCount(
      zip64Fixture(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    )).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("falls back to the declared count for truncated and malformed directory records", () => {
    expect(readZipCentralDirectoryEntryCount(malformedCentralDirectory({ bytes: 10 }))).toBe(1);
    expect(readZipCentralDirectoryEntryCount(malformedCentralDirectory({
      bytes: 46,
      signature: 0x01020304,
    }))).toBe(1);
    expect(readZipCentralDirectoryEntryCount(malformedCentralDirectory({
      bytes: 46,
      signature: 0x02014b50,
      nameLength: 1,
    }))).toBe(1);
  });

  it("classifies uncommon TAR types and preserve-mode defaults", () => {
    expect(archiveEntryKindFromTarType("GNUDumpDir")).toBe("directory");
    expect(archiveEntryKindFromTarType("CharacterDevice")).toBe("other");
    expect(resolveArchiveEntryMode({ kind: "directory", policy: "preserve" })).toBe(0o755);
    expect(resolveArchiveEntryMode({ kind: "file", policy: "preserve" })).toBe(0o644);
  });
});
