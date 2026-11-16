import { resolve } from "node:path";
import { expect, test } from "vitest";
import { nativeBuildOutput } from "../scripts/build-native.mjs";

const manifest = resolve("native", "Cargo.toml");
const artifact = (file: string, source = manifest) => ({
  reason: "compiler-artifact", manifest_path: source,
  target: { crate_types: ["cdylib"] }, filenames: [file],
});
const messages = (...records: object[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

test("selects Cargo's emitted DLL from redirected output rather than a stale default-directory DLL", () => {
  const redirected = resolve("configured-target", "x86_64-pc-windows-msvc", "release", "fs_safe_native.dll");
  const stale = resolve("target", "x86_64-pc-windows-msvc", "release", "fs_safe_native.dll");
  const output = messages(artifact(stale, resolve("other-crate", "Cargo.toml")), artifact(redirected),
    { reason: "build-finished", success: true });
  expect(nativeBuildOutput(output, manifest).artifact).toBe(redirected);
});

test("does not fall back to a default artifact when Cargo reports no matching DLL", () => {
  const stale = resolve("target", "release", "fs_safe_native.dll");
  expect(() => nativeBuildOutput(messages(artifact(stale, resolve("other-crate", "Cargo.toml"))), manifest))
    .toThrow("exactly one native DLL");
  expect(() => nativeBuildOutput(messages(artifact(resolve("target", "fs_safe_native.lib"))), manifest))
    .toThrow("exactly one native DLL");
});

test("rejects ambiguous or relative native artifact reports", () => {
  expect(() => nativeBuildOutput(messages(artifact(resolve("first.dll")), artifact(resolve("second.dll"))), manifest))
    .toThrow("exactly one native DLL");
  expect(() => nativeBuildOutput(messages(artifact("relative.dll")), manifest)).toThrow("exactly one native DLL");
});

test("retains rendered compiler diagnostics while selecting the actual native artifact", () => {
  const output = messages({ reason: "compiler-message", message: { rendered: "warning: native build diagnostic\n" } },
    artifact(resolve("configured-target", "fs_safe_native.dll")));
  expect(nativeBuildOutput(output, manifest).diagnostics).toEqual(["warning: native build diagnostic\n"]);
});
