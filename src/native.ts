import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FsSafeError } from "./errors.js";
import type { NativeBinding } from "./native-binding.js";
import { getFsSafeNativeConfig } from "./native-config.js";

export type { NativeBinding } from "./native-binding.js";

const require = createRequire(import.meta.url);
const bundledNativeDirectory = fileURLToPath(new URL("../dist/native/", import.meta.url));
let binding: NativeBinding | undefined;
let loadError: unknown;
let attempted = false;
let loadBinding = loadBundledBinding;

function isMuslFilename(file: string): boolean {
  return file.includes("libc.musl-") || file.includes("ld-musl-");
}

function isMuslFromReport(): boolean | undefined {
  try {
    if (!process.report || typeof process.report.getReport !== "function") return undefined;
    const report = process.report.getReport() as {
      header?: { glibcVersionRuntime?: string };
      sharedObjects?: string[];
    };
    if (report.header?.glibcVersionRuntime) return false;
    if (report.sharedObjects?.some(isMuslFilename)) return true;
  } catch {
    // Continue with filesystem and ELF inspection.
  }
  return undefined;
}

function isMuslFromFilesystem(): boolean | undefined {
  for (const directory of ["/lib", "/usr/lib"]) {
    try {
      if (readdirSync(directory).some(isMuslFilename)) return true;
    } catch {
      // A missing or unreadable conventional library directory is inconclusive.
    }
  }
  return undefined;
}

function readUInt(
  buffer: Buffer,
  offset: number,
  bytes: 2 | 4 | 8,
  littleEndian: boolean,
): number | undefined {
  if (offset < 0 || offset + bytes > buffer.length) return undefined;
  if (bytes === 2) return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  if (bytes === 4) return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function isMuslFromElfInterpreter(): boolean | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(process.execPath, "r");
    const header = Buffer.alloc(64);
    if (readSync(fd, header, 0, header.length, 0) < 52) return undefined;
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return undefined;

    const elfClass = header[4];
    const dataEncoding = header[5];
    if ((elfClass !== 1 && elfClass !== 2) || (dataEncoding !== 1 && dataEncoding !== 2)) {
      return undefined;
    }
    const littleEndian = dataEncoding === 1;
    const is64Bit = elfClass === 2;
    const tableOffset = readUInt(header, is64Bit ? 32 : 28, is64Bit ? 8 : 4, littleEndian);
    const entrySize = readUInt(header, is64Bit ? 54 : 42, 2, littleEndian);
    const entryCount = readUInt(header, is64Bit ? 56 : 44, 2, littleEndian);
    if (
      tableOffset === undefined ||
      entrySize === undefined ||
      entryCount === undefined ||
      entrySize < (is64Bit ? 56 : 32) ||
      entryCount > 1024
    ) {
      return undefined;
    }

    const programHeader = Buffer.alloc(entrySize);
    for (let index = 0; index < entryCount; index += 1) {
      const offset: number = tableOffset + index * entrySize;
      if (readSync(fd, programHeader, 0, entrySize, offset) !== entrySize) return undefined;
      if (readUInt(programHeader, 0, 4, littleEndian) !== 3) continue;
      const interpreterOffset = readUInt(
        programHeader,
        is64Bit ? 8 : 4,
        is64Bit ? 8 : 4,
        littleEndian,
      );
      const interpreterSize = readUInt(
        programHeader,
        is64Bit ? 32 : 16,
        is64Bit ? 8 : 4,
        littleEndian,
      );
      if (
        interpreterOffset === undefined ||
        interpreterSize === undefined ||
        interpreterSize < 1 ||
        interpreterSize > 4096
      ) {
        return undefined;
      }
      const interpreter = Buffer.alloc(interpreterSize);
      if (
        readSync(fd, interpreter, 0, interpreterSize, interpreterOffset) !== interpreterSize
      ) {
        return undefined;
      }
      return isMuslFilename(interpreter.toString("utf8"));
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort detection must never turn close failure into import failure.
      }
    }
  }
  return undefined;
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  for (const detector of [isMuslFromReport, isMuslFromFilesystem, isMuslFromElfInterpreter]) {
    const result = detector();
    if (result !== undefined) return result;
  }
  // Unknown Linux libc: try the glibc binary and let its require fail normally.
  return false;
}

function targetFor(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
): string | undefined {
  if (platform === "win32" && arch === "x64") return "win32-x64-msvc";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return `linux-${arch}-${musl ? "musl" : "gnu"}`;
  }
  return undefined;
}

function bundledTarget(): string | undefined {
  return targetFor(process.platform, process.arch, isMusl());
}

function loadBundledBinding(): NativeBinding {
  const target = bundledTarget();
  if (!target) {
    throw new Error(`Unsupported OS or architecture: ${process.platform}-${process.arch}`);
  }
  return require(join(bundledNativeDirectory, target, "fs-safe-native.node")) as NativeBinding;
}

export function __loadBundledNativeForTest(): NativeBinding {
  return loadBundledBinding();
}

export function __nativeLoaderDetectorsForTest(): {
  report: boolean | undefined;
  filesystem: boolean | undefined;
  elfInterpreter: boolean | undefined;
} {
  return {
    report: isMuslFromReport(),
    filesystem: isMuslFromFilesystem(),
    elfInterpreter: isMuslFromElfInterpreter(),
  };
}

export function __nativeTargetForTest(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): string | undefined {
  return targetFor(platform, arch, musl);
}

export function getNativeBinding(): NativeBinding | undefined {
  const { mode } = getFsSafeNativeConfig();
  if (mode === "off") return undefined;
  if (!attempted) {
    attempted = true;
    try {
      binding = loadBinding();
    } catch (error) {
      loadError = error;
    }
  }
  if (binding) return binding;
  if (mode === "require") {
    throw new FsSafeError("helper-unavailable", "native fs-safe helper is unavailable", {
      cause: loadError,
    });
  }
  return undefined;
}

export function requireNativeBinding(): NativeBinding {
  const native = getNativeBinding();
  if (!native) {
    throw new FsSafeError("helper-unavailable", "native fs-safe helper is unavailable", {
      cause: loadError,
    });
  }
  return native;
}

export function __setNativeLoaderForTest(loader: () => NativeBinding): void {
  binding = undefined;
  loadError = undefined;
  attempted = false;
  loadBinding = loader;
}

export function __resetNativeLoaderForTest(): void {
  binding = undefined;
  loadError = undefined;
  attempted = false;
  loadBinding = loadBundledBinding;
}
