import { expect, test } from "vitest";
import { verifyWindowsHelper, verifyWindowsRuntime, windowsRuntimeEnv } from "../scripts/windows-runtime.mjs";
import { certificateOverlay, windowsPe } from "./helpers/windows-pe.js";

test.each(["x64", "arm64"] as const)("admits native %s OS UCRT imports and rejects wrong architecture or kind", cpu => {
  const bytes = windowsPe(cpu, ["KERNEL32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"], ["ucrtbase.dll"]);
  expect(verifyWindowsRuntime(bytes, cpu)).toEqual({
    cpu, imports: ["api-ms-win-crt-runtime-l1-1-0.dll", "kernel32.dll"], delayImports: ["ucrtbase.dll"],
  });
  expect(() => verifyWindowsRuntime(bytes, cpu === "x64" ? "arm64" : "x64")).toThrow("wrong machine");
  bytes.writeUInt16LE(2, 150);
  expect(() => verifyWindowsRuntime(bytes, cpu)).toThrow("expected a DLL");
});

test.each(["VCRUNTIME140.dll", "vcruntime140_1.dll", "MSVCP140_2.dll", "concrt140.dll", "vcomp140.dll",
  "msvcr120.dll", "vccorlib140.dll", "ucrtbased.dll"])("rejects ordinary and delayed %s dependencies", name => {
  expect(() => verifyWindowsRuntime(windowsPe("x64", ["ucrtbase.dll", name]), "x64")).toThrow("VC redistributable");
  expect(() => verifyWindowsRuntime(windowsPe("arm64", ["ucrtbase.dll"], [name]), "arm64")).toThrow("VC redistributable");
  expect(() => verifyWindowsHelper(windowsPe("anycpu", ["mscoree.dll"], [name]))).toThrow("VC redistributable");
});

test("requires real UCRT imports, not arbitrary DLL name strings", () => {
  const bytes = windowsPe("x64", ["kernel32.dll"]);
  bytes.write("ucrtbase.dll", 3000, "ascii");
  expect(() => verifyWindowsRuntime(bytes, "x64")).toThrow("OS-provided UCRT");
  const clean = windowsPe("x64");
  clean.write("VCRUNTIME140.dll", 3000, "ascii");
  expect(verifyWindowsRuntime(clean, "x64").imports).toEqual(["ucrtbase.dll"]);
});

test("accepts the managed AnyCPU CLR helper without imposing native addon linkage", () => {
  expect(verifyWindowsHelper(windowsPe("anycpu"))).toEqual({
    cpu: "anycpu", imports: ["mscoree.dll"], delayImports: [],
  });
  expect(() => verifyWindowsRuntime(windowsPe("anycpu"), "x64")).toThrow("wrong machine");
  expect(() => verifyWindowsHelper(windowsPe("x64"))).toThrow("wrong machine");
  const mixed = windowsPe("anycpu");
  mixed.writeUInt32LE(0, 1552);
  expect(() => verifyWindowsHelper(mixed)).toThrow("IL-only AnyCPU");
  mixed.writeUInt32LE(3, 1552);
  expect(() => verifyWindowsHelper(mixed)).toThrow("IL-only AnyCPU");
  const missingClr = windowsPe("anycpu");
  missingClr.fill(0, 152 + 96 + 14 * 8, 152 + 96 + 15 * 8);
  expect(() => verifyWindowsHelper(missingClr)).toThrow("missing CLR");
});

test.each(["x64", "arm64", "anycpu"] as const)("inspects %s without modifying Authenticode overlays", cpu => {
  const bytes = certificateOverlay(windowsPe(cpu));
  const original = Buffer.from(bytes);
  if (cpu === "anycpu") verifyWindowsHelper(bytes);
  else verifyWindowsRuntime(bytes, cpu);
  expect(bytes.equals(original)).toBe(true);
});

test("rejects truncated headers, directory bounds, legacy delay VAs and unterminated names", () => {
  expect(() => verifyWindowsRuntime(windowsPe("x64").subarray(0, 200), "x64")).toThrow("truncated PE");
  const unmapped = windowsPe("x64");
  unmapped.writeUInt32LE(8000, 512 + 12);
  expect(() => verifyWindowsRuntime(unmapped, "x64")).toThrow("unmapped");
  const table = windowsPe("x64");
  table.writeUInt32LE(20, 152 + 112 + 8 + 4);
  expect(() => verifyWindowsRuntime(table, "x64")).toThrow("unterminated import directory");
  const name = windowsPe("x64");
  name.fill(65, 2048);
  expect(() => verifyWindowsRuntime(name, "x64")).toThrow("unterminated DLL name");
  const delay = windowsPe("x64", ["ucrtbase.dll"], ["kernel32.dll"]);
  delay.writeUInt32LE(0, 1024);
  expect(() => verifyWindowsRuntime(delay, "x64")).toThrow("delay-import attributes");
});

test("preserves inherited flags and Cargo encoded precedence without changing the parent environment", () => {
  const inherited = { RUSTFLAGS: "-Cdebuginfo=1", CARGO_ENCODED_RUSTFLAGS: "-C\x1fopt-level=1" };
  const encoded = windowsRuntimeEnv(inherited);
  expect(encoded.RUSTFLAGS).toBe(inherited.RUSTFLAGS);
  expect(encoded.CARGO_ENCODED_RUSTFLAGS.split("\x1f").slice(0, 2)).toEqual(["-C", "opt-level=1"]);
  expect(encoded.CARGO_ENCODED_RUSTFLAGS).toContain("\x1f-Ctarget-feature=+crt-static");
  expect(inherited.CARGO_ENCODED_RUSTFLAGS).toBe("-C\x1fopt-level=1");
  expect(windowsRuntimeEnv({ CARGO_ENCODED_RUSTFLAGS: "", RUSTFLAGS: "ignored" }).CARGO_ENCODED_RUSTFLAGS)
    .toMatch(/^-Ctarget-feature=/);
  expect(windowsRuntimeEnv({ RUSTFLAGS: "-Cdebuginfo=1" }).RUSTFLAGS).toMatch(/^-Cdebuginfo=1 -Ctarget-feature=/);
});

test.runIf(process.platform === "win32")("preserves case-insensitive Windows flags in the copied Cargo environment", () => {
  const env = windowsRuntimeEnv({ Rustflags: "ignored", Cargo_Encoded_Rustflags: "-C\x1fdebuginfo=1" });
  expect(env.RUSTFLAGS).toBe("ignored");
  expect(env.CARGO_ENCODED_RUSTFLAGS).toMatch(/^-C\x1fdebuginfo=1\x1f-Ctarget-feature=/);
  expect(Object.keys(env).filter(key => key.toUpperCase() === "CARGO_ENCODED_RUSTFLAGS")).toEqual(["CARGO_ENCODED_RUSTFLAGS"]);
});

test("preserves the napi CARGO_BUILD_RUSTFLAGS fallback and explicit higher-precedence empty values", () => {
  const unexpected = () => { throw new Error("lower-precedence configuration must not be read"); };
  expect(windowsRuntimeEnv({ CARGO_BUILD_RUSTFLAGS: "-Cdebuginfo=1" }, unexpected).RUSTFLAGS)
    .toMatch(/^-Cdebuginfo=1 -Ctarget-feature=/);
  expect(windowsRuntimeEnv({ RUSTFLAGS: "", CARGO_BUILD_RUSTFLAGS: "-Cdebuginfo=1" }, unexpected).RUSTFLAGS)
    .toMatch(/^-Ctarget-feature=/);
  expect(windowsRuntimeEnv({ CARGO_ENCODED_RUSTFLAGS: "", CARGO_BUILD_RUSTFLAGS: "-Cdebuginfo=1" }, unexpected)
    .CARGO_ENCODED_RUSTFLAGS).toMatch(/^-Ctarget-feature=/);
});

test("extends Cargo-resolved configuration without reparsing flags containing spaces", () => {
  const flags = "-C\x1flink-arg=/LIBPATH:directory with spaces";
  expect(windowsRuntimeEnv({}, () => flags).CARGO_ENCODED_RUSTFLAGS)
    .toMatch(/^-C\x1flink-arg=\/LIBPATH:directory with spaces\x1f-Ctarget-feature=/);
  expect(windowsRuntimeEnv({ CARGO_BUILD_RUSTFLAGS: "" }, () => flags).CARGO_ENCODED_RUSTFLAGS)
    .toMatch(/^-C\x1flink-arg=\/LIBPATH:directory with spaces\x1f-Ctarget-feature=/);
});
