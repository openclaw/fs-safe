import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { FsSafeError } from "./errors.js";
import { captureNativeFdClose, type NativeBinding, type CapableNativeBinding } from "./native-binding.js";
import { getFsSafeNativeConfig, getNativeModeSetting } from "./native-config.js";

export type { NativeBinding } from "./native-binding.js";

const require = createRequire(import.meta.url);
// Native registration creates process-lifetime housekeeping. Use the import
// context rather than retaining the first operation's AsyncLocalStorage stores.
const runNativeInitialization = AsyncLocalStorage.snapshot();
let binding: NativeBinding | undefined;
let loadError: unknown;
let attempted = false;
let loadBinding = loadBundledBinding;
let resolvePackage = (name: string): string => require.resolve(name);
type LoadOutcome =
  | { reason: "not-probed" | "loaded" | "unsupported-target" | "package-missing" }
  | { reason: "load-failed"; code: string }
  | { reason: "capability-missing"; capabilities: (keyof NativeBinding)[] };
let loadOutcome: LoadOutcome = { reason: "not-probed" };
let selectedTarget: string | undefined;
let targetDescription: string | undefined;

function loadFailure(error: unknown, packageName: string): LoadOutcome {
  try {
    return classifyLoadFailure(error, packageName);
  } catch {
    // Diagnostic inspection must not replace an arbitrary thrown load value.
    return { reason: "load-failed", code: "UNKNOWN" };
  }
}

function classifyLoadFailure(error: unknown, packageName: string): LoadOutcome {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  // Resolution must fail for the selected package itself. An exception inside
  // an installed package (even one naming this package) is not package omission.
  if (code === "MODULE_NOT_FOUND" && error instanceof Error &&
    error.message.split("\n", 1)[0] === `Cannot find module '${packageName}'`) {
    try { resolvePackage(packageName); } catch (resolutionError) {
      if (resolutionError instanceof Error && "code" in resolutionError &&
        resolutionError.code === "MODULE_NOT_FOUND" &&
        resolutionError.message.split("\n", 1)[0] === `Cannot find module '${packageName}'`) {
        return { reason: "package-missing" };
      }
    }
  }
  // An allowlist excludes paths, secrets and arbitrary text in exception codes.
  const knownCodes = ["ERR_DLOPEN_FAILED", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND",
    "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_INVALID_PACKAGE_CONFIG", "EACCES", "EPERM", "ENOENT"];
  return { reason: "load-failed", code: typeof code === "string" && knownCodes.includes(code) ? code : "UNKNOWN" };
}

/** Internal view of the cached load; never attempts to load an addon. */
export function getNativeFallbackDiagnostic(...capabilities: (keyof NativeBinding)[]) {
  const setting = getNativeModeSetting();
  const target = targetDescription === undefined ? bundledTarget() : selectedTarget;
  const packageName = target === undefined ? undefined : nativePackageForTarget(target);
  const manifest = require("../package.json") as { optionalDependencies: Record<string, string> };
  const expected = {
    target: targetDescription!,
    packageName,
    packageVersion: packageName === undefined ? undefined : manifest.optionalDependencies[packageName],
  };
  if (setting.mode === "off") return { ...expected, reason: "disabled" as const, source: setting.source };
  const loaded = binding;
  if (loaded) {
    const missing = capabilities.filter(name => typeof loaded[name] !== "function");
    if (missing.length) return { ...expected, reason: "capability-missing" as const, capabilities: missing };
  }
  return { ...expected, ...loadOutcome };
}

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
    // Continue with ELF and filesystem inspection.
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
  for (const detector of [isMuslFromReport, isMuslFromElfInterpreter, isMuslFromFilesystem]) {
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
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return `win32-${arch}-msvc`;
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "freebsd" && (arch === "x64" || arch === "arm64")) return `freebsd-${arch}`;
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return `linux-${arch}-${musl ? "musl" : "gnu"}`;
  }
  return undefined;
}

function bundledTarget(): string | undefined {
  const musl = isMusl();
  selectedTarget = targetFor(process.platform, process.arch, musl);
  targetDescription = selectedTarget ?? `${process.platform}-${process.arch}${process.platform === "linux" ? `-${musl ? "musl" : "gnu"}` : ""}`;
  return selectedTarget;
}

function nativePackageForTarget(target: string): string {
  return `@openclaw/fs-safe-${target}`;
}

function loadBundledBinding(): NativeBinding {
  const target = bundledTarget();
  if (!target) {
    loadOutcome = { reason: "unsupported-target" };
    throw new Error(`Unsupported OS or architecture: ${process.platform}-${process.arch}`);
  }
  const loaded = runNativeInitialization(() => require(nativePackageForTarget(target))) as NativeBinding;
  if (typeof loaded.closeOwnedFd !== "function") {
    loadOutcome = { reason: "capability-missing", capabilities: ["closeOwnedFd"] };
  }
  captureNativeFdClose(loaded);
  return loaded;
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

export function selectNativeBinding<K extends keyof NativeBinding>(
  native: NativeBinding | undefined, ...capabilities: K[]
): CapableNativeBinding<K> | undefined {
  if (!native) return undefined;
  const missing = capabilities.filter((name) => typeof native[name] !== "function");
  if (missing.length === 0) return native as CapableNativeBinding<K>;
  if (getFsSafeNativeConfig().mode === "require") {
    throw new FsSafeError("helper-unavailable", `native fs-safe capabilities unavailable: ${missing.join(", ")}`);
  }
  return undefined;
}

export function assertNativeCapabilities<K extends keyof NativeBinding>(
  native: NativeBinding, ...capabilities: K[]
): asserts native is CapableNativeBinding<K> {
  const missing = capabilities.filter((name) => typeof native[name] !== "function");
  if (missing.length) {
    throw new FsSafeError("helper-unavailable", `native fs-safe capabilities unavailable: ${missing.join(", ")}`);
  }
}

export function getNativeBinding<K extends keyof NativeBinding = never>(...capabilities: K[]): CapableNativeBinding<K> | undefined {
  const { mode } = getFsSafeNativeConfig();
  if (mode === "off") return undefined;
  if (!attempted) {
    attempted = true;
    try {
      const loaded = loadBinding();
      if (typeof loaded.closeOwnedFd !== "function") {
        loadOutcome = { reason: "capability-missing", capabilities: ["closeOwnedFd"] };
      }
      captureNativeFdClose(loaded);
      binding = loaded;
      loadOutcome = { reason: "loaded" };
    } catch (error) {
      loadError = error;
      if (loadOutcome.reason === "not-probed") {
        selectedTarget ??= bundledTarget();
        loadOutcome = loadFailure(error, nativePackageForTarget(selectedTarget ?? `${process.platform}-${process.arch}`));
      }
    }
  }
  if (binding) return selectNativeBinding(binding, ...capabilities);
  if (mode === "require") {
    throw new FsSafeError("helper-unavailable", "native fs-safe helper is unavailable", {
      cause: loadError,
    });
  }
  return undefined;
}

export function requireNativeBinding<K extends keyof NativeBinding = never>(...capabilities: K[]): CapableNativeBinding<K> {
  const native = getNativeBinding(...capabilities);
  if (!native) {
    throw new FsSafeError("helper-unavailable", "native fs-safe helper is unavailable", {
      cause: loadError,
    });
  }
  return native;
}

export function __setNativeLoaderForTest(loader: () => NativeBinding, resolver?: (name: string) => string): void {
  binding = undefined;
  loadError = undefined;
  attempted = false;
  loadBinding = loader;
  loadOutcome = { reason: "not-probed" };
  selectedTarget = undefined;
  targetDescription = undefined;
  resolvePackage = resolver ?? ((name) => require.resolve(name));
}

export function __resetNativeLoaderForTest(): void {
  binding = undefined;
  loadError = undefined;
  attempted = false;
  loadBinding = loadBundledBinding;
  loadOutcome = { reason: "not-probed" };
  selectedTarget = undefined;
  targetDescription = undefined;
  resolvePackage = (name) => require.resolve(name);
}
