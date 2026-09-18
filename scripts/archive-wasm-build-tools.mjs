import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const WASM_TARGET = "wasm32-unknown-unknown";
export const WASM_MAX_MEMORY = 256 * 1024 * 1024;

function override(env, name) {
  for (const key of [`${name}_${WASM_TARGET}`, `${name}_wasm32_unknown_unknown`, `TARGET_${name}`, name]) {
    if (env[key]?.trim()) return { key, value: env[key].trim() };
  }
}

function command(value) {
  // Match cc-rs: an existing path can contain spaces; otherwise whitespace
  // separates an executable, optional compiler wrapper, and default flags.
  if (existsSync(value) || (process.platform === "win32" && existsSync(`${value}.exe`))) return [resolve(value)];
  return value.split(/\s+/u);
}

function probe(value, args, env) {
  const [executable, ...prefix] = command(value);
  return spawnSync(executable, [...prefix, ...args], {
    env, encoding: "utf8", timeout: 15_000, windowsHide: true,
  });
}

function toolCandidates(env, name) {
  const roots = [env.LLVM_PATH, "/opt/homebrew/opt/llvm", "/usr/local/opt/llvm"];
  if (env.ProgramFiles) roots.push(join(env.ProgramFiles, "LLVM"));
  return [
    name,
    ...roots.filter(Boolean).map((root) => resolve(root, "bin", name)),
    ...[21, 20, 19, 18].map((major) => `${name}-${major}`),
  ];
}

function selectTool(env, name, executable, args, accepts, requirement) {
  const explicit = override(env, name);
  const candidates = explicit ? [explicit.value] : toolCandidates(env, executable);
  for (const value of candidates) {
    const result = probe(value, args, env);
    if (result.status === 0 && accepts(result.stdout)) {
      const invocation = command(value);
      return { value: invocation.length === 1 ? invocation[0] : value, key: explicit?.key };
    }
  }
  const selection = explicit ? ` (${explicit.key}=${explicit.value})` : "";
  throw new Error(`TAR WASM build requires ${requirement}${selection}; see docs/contributing.md#build. Native host tools may not support WebAssembly.`);
}

export function archiveWasmBuildEnvironment(input = process.env) {
  const env = { ...input };
  const compiler = selectTool(env, "CC", "clang", ["--print-targets"],
    (stdout) => /^\s*wasm32\s+-/mu.test(stdout), "a clang compiler with the wasm32 target");
  const archiver = selectTool(env, "AR", "llvm-ar", ["--version"],
    (stdout) => /\bLLVM\b/u.test(stdout), "the LLVM llvm-ar archiver");
  // Cargo build scripts run from dependency directories, not this checkout.
  // Pin resolved paths to the highest-precedence target-only overrides.
  env[`CC_${WASM_TARGET}`] = compiler.value;
  env[`AR_${WASM_TARGET}`] = archiver.value;
  // WASI SDK clang ships a default configuration for a different target and
  // libc. Rust/cc-rs selects unknown-unknown; use only zstd's bundled shim.
  const flagsKey = `CFLAGS_${WASM_TARGET}`;
  env[flagsKey] = `${env[flagsKey] ?? ""} --no-default-config`.trim();
  // Rust 1.98.1's optimized WASM LTO fails a valid allocation/free invariant.
  // This child-only override leaves the native release profile unchanged.
  env.CARGO_PROFILE_RELEASE_LTO = "off";
  return env;
}

export function allocatorTestArtifact(env = process.env) {
  return resolve(env.CARGO_TARGET_DIR ?? "target", "archive-wasm-allocator-tests", "archive-parser.wasm");
}

export function validateArchiveWasm(bytes, { allocatorTests = false } = {}) {
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error("TAR WASM must have no host imports");
  if (!allocatorTests && WebAssembly.Module.exports(module).some(({ name }) => name.startsWith("test_"))) {
    throw new Error("TAR WASM production artifact must not expose allocator diagnostics");
  }

  // The JS reflection API does not expose declared memory maxima. Inspect the
  // validated module's memory section instead of allocating 256 MiB to probe it.
  let offset = 8;
  const unsigned = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const size = unsigned();
    const end = offset + size;
    if (id === 5) {
      if (unsigned() !== 1 || unsigned() !== 1) break;
      const minimum = unsigned();
      const maximum = unsigned();
      if (minimum <= maximum && maximum === WASM_MAX_MEMORY / 65536 && offset === end) return module;
      break;
    }
    offset = end;
  }
  throw new Error("TAR WASM must declare one unshared 32-bit memory with a 256 MiB maximum");
}
