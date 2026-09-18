import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { expect, it } from "vitest";
import { archiveWasmBuildEnvironment, validateArchiveWasm } from "../scripts/archive-wasm-build-tools.mjs";

// These integration cases execute real LLVM tools. Match the build's 15-second
// child deadline, with runner headroom beyond the sequential subprocess bounds.
const TOOL_PROBE_TIMEOUT_MS = 15_000;
const probeTestTimeout = (processes: number) => processes * TOOL_PROBE_TIMEOUT_MS + 5_000;

function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}

function section(id: number, bytes: number[]): number[] {
  return [id, ...unsigned(bytes.length), ...bytes];
}

function memoryModule({ maximum = 4096, shared = false, imports = false, diagnostic = false, memories = 1 } = {}) {
  const limit = maximum < 0 ? [0, 1] : [shared ? 3 : 1, 1, ...unsigned(maximum)];
  const name = [...new TextEncoder().encode("test_allocator_probe")];
  return Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...(imports ? [...section(1, [1, 0x60, 0, 0]), ...section(2, [1, 1, 0x65, 1, 0x66, 0, 0])] : []),
    ...section(5, [memories, ...Array.from({ length: memories }, () => limit).flat()]),
    ...(diagnostic ? section(7, [1, name.length, ...name, 2, 0]) : []),
  ]);
}

it("accepts the fixed 256 MiB memory ceiling without instantiating or growing it", () => {
  expect(validateArchiveWasm(memoryModule())).toBeInstanceOf(WebAssembly.Module);
});

it.each([
  { maximum: -1 },
  { maximum: 4097 },
  { maximum: 4095 },
  { shared: true },
  { memories: 0 },
])("rejects a missing, changed, or shared memory contract: %j", (options) => {
  expect(() => validateArchiveWasm(memoryModule(options))).toThrow("one unshared 32-bit memory with a 256 MiB maximum");
});

it("rejects host imports and malformed modules before they can be packaged", () => {
  expect(() => validateArchiveWasm(memoryModule({ imports: true }))).toThrow("no host imports");
  expect(() => validateArchiveWasm(Uint8Array.of(0, 97, 115, 109))).toThrow(WebAssembly.CompileError);
});

it("keeps allocator instrumentation out of production while allowing its separate test artifact", () => {
  const diagnostic = memoryModule({ diagnostic: true });
  expect(() => validateArchiveWasm(diagnostic)).toThrow("must not expose allocator diagnostics");
  expect(validateArchiveWasm(diagnostic, { allocatorTests: true })).toBeInstanceOf(WebAssembly.Module);
});

it("reports an unusable explicit compiler instead of silently falling back", () => {
  const result = spawnSync(process.execPath, ["scripts/build-archive-wasm.mjs"], {
    env: { ...process.env, "CC_wasm32-unknown-unknown": process.execPath },
    encoding: "utf8", timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("clang compiler with the wasm32 target");
  expect(result.stderr).toContain("CC_wasm32-unknown-unknown");
}, probeTestTimeout(2)); // The build-script child has its own 30-second deadline.

it("requires an LLVM archiver even when an explicit host archiver can be executed", () => {
  expect(() => archiveWasmBuildEnvironment({
    ...process.env, "AR_wasm32-unknown-unknown": process.execPath,
  })).toThrow("LLVM llvm-ar archiver");
}, probeTestTimeout(2)); // One compiler probe, then the rejected archiver probe.

it("scopes the verified compiler and LTO policy to the WASM child without changing caller settings", () => {
  const caller = { ...process.env, CARGO_PROFILE_RELEASE_LTO: "true" };
  const env = archiveWasmBuildEnvironment(caller);
  expect(env).not.toBe(caller);
  expect(caller.CARGO_PROFILE_RELEASE_LTO).toBe("true");
  expect(env.CARGO_PROFILE_RELEASE_LTO).toBe("off");
  expect(env.CC).toBe(caller.CC);
  expect(env.AR).toBe(caller.AR);
}, probeTestTimeout(2)); // Compiler and archiver capability probes.

it("keeps relative tool selections usable from Cargo dependency directories", () => {
  const selected = archiveWasmBuildEnvironment();
  const toolPath = (value: string) => {
    if (isAbsolute(value)) return realpathSync(value);
    const suffix = process.platform === "win32" ? ".exe" : "";
    const found = (process.env.PATH ?? "").split(delimiter)
      .map((directory) => join(directory, `${value}${suffix}`)).find(existsSync);
    if (!found) throw new Error(`Could not resolve the selected test compiler: ${value}`);
    return realpathSync(found);
  };
  const compiler = toolPath(selected["CC_wasm32-unknown-unknown"]);
  const archiver = toolPath(selected["AR_wasm32-unknown-unknown"]);
  const explicit = archiveWasmBuildEnvironment({
    ...process.env,
    "CC_wasm32-unknown-unknown": relative(process.cwd(), compiler),
    "AR_wasm32-unknown-unknown": relative(process.cwd(), archiver),
  });
  expect(spawnSync(explicit["CC_wasm32-unknown-unknown"], ["--print-targets"], {
    cwd: tmpdir(), timeout: TOOL_PROBE_TIMEOUT_MS,
  }).status).toBe(0);
  expect(spawnSync(explicit["AR_wasm32-unknown-unknown"], ["--version"], {
    cwd: tmpdir(), timeout: TOOL_PROBE_TIMEOUT_MS,
  }).status).toBe(0);

  const discoveredInput = { ...process.env, PATH: "", LLVM_PATH: relative(process.cwd(), join(dirname(archiver), "..")) };
  for (const name of ["CC", "AR"]) {
    for (const key of [name, `TARGET_${name}`, `${name}_wasm32_unknown_unknown`, `${name}_wasm32-unknown-unknown`]) {
      delete discoveredInput[key];
    }
  }
  const discovered = archiveWasmBuildEnvironment(discoveredInput);
  expect(isAbsolute(discovered["CC_wasm32-unknown-unknown"])).toBe(true);
  expect(isAbsolute(discovered["AR_wasm32-unknown-unknown"])).toBe(true);
  expect(spawnSync(discovered["CC_wasm32-unknown-unknown"], ["--print-targets"], {
    cwd: tmpdir(), timeout: TOOL_PROBE_TIMEOUT_MS,
  }).status).toBe(0);
}, probeTestTimeout(9)); // Three compiler/archiver pairs plus three cwd probes.
