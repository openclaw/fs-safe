import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { arch } from "node:os";
import path from "node:path";
import { getSystemErrorName } from "node:util";

type Pointer = number | bigint;
type Libc = {
  library: ReturnType<BunFfi["dlopen"]>;
  CString: BunFfi["CString"];
  errno: Int32Array;
  symbols: {
    realpath: (input: Uint8Array, output: null) => Pointer | null;
    free: (pointer: Pointer) => void;
    errno: () => Pointer;
  };
};
type BunFfi = {
  dlopen: (library: string, symbols: Record<string, { args: string[]; returns: string }>) => {
    symbols: Record<string, (...args: never[]) => unknown>;
  };
  CString: new(pointer: Pointer) => { toString(): string };
  toArrayBuffer: (pointer: Pointer, byteOffset: number, byteLength: number) => ArrayBuffer;
};

let libc: Libc | undefined;

function libcPath(platform: "darwin" | "linux"): string {
  if (platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  const isLibc = (file: string) => path.posix.isAbsolute(file) &&
    /^(?:libc\.so\.6|(?:libc\.|ld-)musl-[\w-]+\.so\.1)$/.test(path.posix.basename(file));
  try {
    // Bun's process.report has no sharedObjects. The kernel map identifies the
    // already-loaded libc, including distributions with nonstandard store paths.
    for (const line of readFileSync("/proc/self/maps", "utf8").split("\n")) {
      const file = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];
      if (file && isLibc(file)) return file;
    }
  } catch {
    // A hidden proc mount still permits the fixed system locations below.
  }
  const machine = arch() === "arm64" ? "aarch64" : arch() === "x64" ? "x86_64" : undefined;
  const candidates = [
    ...(machine ? [`/lib/${machine}-linux-gnu/libc.so.6`, `/lib/ld-musl-${machine}.so.1`] : []),
    "/lib64/libc.so.6", "/usr/lib64/libc.so.6", "/usr/lib/libc.so.6",
  ];
  const library = candidates.find((file) => existsSync(file));
  if (!library) throw new Error("Bun realpath compatibility could not locate system libc");
  return library;
}

function loadLibc(platform: "darwin" | "linux"): Libc {
  // Bun's builtin FFI supplies the runtime syscall missing from its fs shim.
  // Never search cwd for a library or enable the optional fs-safe native helper.
  const ffi = createRequire(import.meta.url)("bun:ffi") as BunFfi;
  const realpathSymbol = platform === "darwin" ? "realpath$DARWIN_EXTSN" : "realpath";
  const errnoSymbol = platform === "darwin" ? "__error" : "__errno_location";
  const library = ffi.dlopen(libcPath(platform), {
    [realpathSymbol]: { args: ["buffer", "ptr"], returns: "ptr" },
    free: { args: ["ptr"], returns: "void" },
    [errnoSymbol]: { args: [], returns: "ptr" },
  });
  const symbols: Libc["symbols"] = {
    realpath: library.symbols[realpathSymbol] as Libc["symbols"]["realpath"],
    free: library.symbols.free as Libc["symbols"]["free"],
    errno: library.symbols[errnoSymbol] as Libc["symbols"]["errno"],
  };
  // This module and its thread-local errno view belong to one JS worker.
  const errno = new Int32Array(ffi.toArrayBuffer(symbols.errno(), 0, 4));
  return { library, symbols, CString: ffi.CString, errno };
}

export function bunRealpathSync(input: string, platform: "darwin" | "linux"): string {
  if (input.includes("\0")) {
    throw Object.assign(new TypeError("realpath input must not contain null bytes"), {
      code: "ERR_INVALID_ARG_VALUE",
    });
  }
  libc ??= loadLibc(platform);
  const bytes = Buffer.from(`${input}\0`);
  const result = libc.symbols.realpath(bytes, null);
  if (result === null) {
    // Capture errno before formatting the error can invoke other native code.
    const number = libc.errno[0]!;
    const code = getSystemErrorName(-number);
    throw Object.assign(new Error(`${code}: realpath '${input}'`), {
      code, errno: -number, syscall: "realpath", path: input,
    });
  }
  try {
    return new libc.CString(result).toString();
  } finally {
    // CString copies the bytes; no borrowed native memory escapes this call.
    libc.symbols.free(result);
  }
}
