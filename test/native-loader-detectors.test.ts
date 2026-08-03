import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeErrorSync } from "./helpers/security.js";
import {
  __nativeLoaderDetectorsForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  requireNativeBinding,
} from "../src/native.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function installElfReads(parts: Map<number, Buffer>, closeError?: Error): void {
  vi.spyOn(fs, "openSync").mockReturnValue(91);
  vi.spyOn(fs, "readSync").mockImplementation((
    _fd,
    buffer,
    offset,
    length,
    position,
  ) => {
    const source = parts.get(Number(position));
    if (!source) return 0;
    const bytes = Math.min(length, source.length);
    source.copy(buffer as Buffer, offset, 0, bytes);
    return bytes;
  });
  vi.spyOn(fs, "closeSync").mockImplementation(() => {
    if (closeError) throw closeError;
  });
  syncBuiltinESMExports();
}

function elf64(params: {
  interpreter?: string;
  type?: number;
  entrySize?: number;
  entryCount?: number;
  interpreterSize?: number;
  tableOffset?: bigint;
} = {}): Map<number, Buffer> {
  const tableOffset = params.tableOffset ?? 64n;
  const entrySize = params.entrySize ?? 56;
  const interpreterOffset = 128n;
  const interpreter = Buffer.from(params.interpreter ?? "/lib64/ld-linux-x86-64.so.2\0");
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeBigUInt64LE(tableOffset, 32);
  header.writeUInt16LE(entrySize, 54);
  header.writeUInt16LE(params.entryCount ?? 1, 56);
  const programHeader = Buffer.alloc(entrySize);
  if (entrySize >= 4) programHeader.writeUInt32LE(params.type ?? 3, 0);
  if (entrySize >= 40) {
    programHeader.writeBigUInt64LE(interpreterOffset, 8);
    programHeader.writeBigUInt64LE(BigInt(params.interpreterSize ?? interpreter.length), 32);
  }
  return new Map([
    [0, header],
    [Number(tableOffset), programHeader],
    [Number(interpreterOffset), interpreter],
  ]);
}

function elf32BigEndian(interpreter: string): Map<number, Buffer> {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 1, 2]);
  header.writeUInt32BE(64, 28);
  header.writeUInt16BE(32, 42);
  header.writeUInt16BE(1, 44);
  const programHeader = Buffer.alloc(32);
  programHeader.writeUInt32BE(3, 0);
  programHeader.writeUInt32BE(96, 4);
  const encoded = Buffer.from(`${interpreter}\0`);
  programHeader.writeUInt32BE(encoded.length, 16);
  return new Map([
    [0, header],
    [64, programHeader],
    [96, encoded],
  ]);
}

describe("native libc detector failures", () => {
  it("handles glibc, musl, inconclusive, and failed process reports", () => {
    const getReport = vi.spyOn(process.report, "getReport");
    getReport.mockReturnValue({ header: { glibcVersionRuntime: "2.39" } } as never);
    expect(__nativeLoaderDetectorsForTest().report).toBe(false);
    getReport.mockReturnValue({ sharedObjects: ["/lib/ld-musl-x86_64.so.1"] } as never);
    expect(__nativeLoaderDetectorsForTest().report).toBe(true);
    getReport.mockReturnValue({ header: {}, sharedObjects: [] } as never);
    expect(__nativeLoaderDetectorsForTest().report).toBeUndefined();
    getReport.mockImplementation(() => {
      throw new Error("report disabled");
    });
    expect(__nativeLoaderDetectorsForTest().report).toBeUndefined();
  });

  it("continues past unreadable conventional directories and recognizes musl filenames", () => {
    vi.spyOn(fs, "readdirSync").mockImplementation((directory) => {
      if (String(directory) === "/lib") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return ["ld-musl-aarch64.so.1"] as never;
    });
    syncBuiltinESMExports();
    expect(__nativeLoaderDetectorsForTest().filesystem).toBe(true);

    vi.mocked(fs.readdirSync).mockReturnValue([] as never);
    syncBuiltinESMExports();
    expect(__nativeLoaderDetectorsForTest().filesystem).toBeUndefined();
  });

  it("parses little-endian 64-bit and big-endian 32-bit ELF interpreters", () => {
    installElfReads(elf64({ interpreter: "/lib/ld-musl-x86_64.so.1" }));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBe(true);

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    installElfReads(elf32BigEndian("/lib/ld-linux.so.2"));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBe(false);
  });

  it("treats truncated, non-ELF, and invalid-class executables as inconclusive", () => {
    installElfReads(new Map([[0, Buffer.alloc(51)]]));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    installElfReads(new Map([[0, Buffer.alloc(64)]]));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    const invalid = Buffer.alloc(64);
    invalid.set([0x7f, 0x45, 0x4c, 0x46, 3, 3]);
    installElfReads(new Map([[0, invalid]]));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();
  });

  it("rejects unsafe tables and malformed interpreter records", () => {
    installElfReads(elf64({ entrySize: 32 }));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    installElfReads(elf64({ entryCount: 1025 }));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    installElfReads(elf64({ tableOffset: BigInt(Number.MAX_SAFE_INTEGER) + 1n }));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    installElfReads(elf64({ interpreterSize: 0 }));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    installElfReads(elf64({ interpreterSize: 4097 }));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();
  });

  it("handles missing interpreter headers, short reads, open errors, and close errors", () => {
    installElfReads(elf64({ type: 1 }));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    const shortProgramHeader = elf64();
    shortProgramHeader.set(64, Buffer.alloc(8));
    installElfReads(shortProgramHeader);
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    const shortInterpreter = elf64();
    shortInterpreter.set(128, Buffer.from("short"));
    installElfReads(shortInterpreter);
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBeUndefined();

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    installElfReads(elf64(), new Error("close failed"));
    expect(__nativeLoaderDetectorsForTest().elfInterpreter).toBe(false);
  });

  it("fails closed when callers explicitly require an unavailable binding", () => {
    __setNativeLoaderForTest(() => {
      throw new Error("binding missing");
    });
    configureFsSafeNative({ mode: "auto" });
    expectFsSafeErrorSync(() => requireNativeBinding(), "helper-unavailable");
  });
});
