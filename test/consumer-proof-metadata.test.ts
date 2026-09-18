import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertInstalledScriptPath, nativeBinaryLoaded, packageProofSource, windowsSecurityFixturePhases } from "../scripts/consumer-proof-metadata.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.unstubAllEnvs());

it("records the actual checkout rather than workflow head metadata", () => {
  const source = packageProofSource();
  expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(source.tree).toMatch(/^[0-9a-f]{40}$/);
  expect(typeof source.dirty).toBe("boolean");
});

it("marks source metadata unavailable when Git is absent", async () => {
  const directory = await tempRoot("fs-safe-proof-no-git-");
  vi.stubEnv("PATH", directory);
  expect(packageProofSource(directory)).toEqual({ unavailable: "git-not-installed" });
});

it("marks source archives without a Git checkout explicitly", async () => {
  const directory = await tempRoot("fs-safe-proof-no-checkout-");
  expect(packageProofSource(directory)).toEqual({ unavailable: "git-metadata-unavailable" });
});

it("requires the actual binary in the loaded-object list, not mere file presence", async () => {
  const directory = await tempRoot("fs-safe-proof-loaded-");
  const binary = path.join(directory, "host.node");
  const other = path.join(directory, "other.node");
  await fs.writeFile(binary, "synthetic metadata fixture");
  await fs.writeFile(other, "synthetic metadata fixture");
  expect(nativeBinaryLoaded(binary, [])).toBe(false);
  expect(nativeBinaryLoaded(binary, [other])).toBe(false);
  expect(nativeBinaryLoaded(binary, [binary])).toBe(true);
});

it("accepts a Windows loader namespace spelling of the same binary", async () => {
  const directory = await tempRoot("fs-safe-proof-loader-path-");
  const binary = path.join(directory, "host.node");
  await fs.writeFile(binary, "synthetic metadata fixture");
  const reported = path.toNamespacedPath(binary);
  if (process.platform === "win32") expect(reported).toMatch(/^\\\\\?\\/);
  expect(nativeBinaryLoaded(binary, [reported])).toBe(true);
});

it("does not silently accept an unreadable reported native object", async () => {
  const directory = await tempRoot("fs-safe-proof-missing-object-");
  const binary = path.join(directory, "host.node");
  await fs.writeFile(binary, "synthetic metadata fixture");
  expect(() => nativeBinaryLoaded(binary, [path.join(directory, "missing.node")]))
    .toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it("accepts an alternate filesystem spelling of the verified installed script", async () => {
  const directory = await tempRoot("fs-safe-proof-script-alias-");
  const installed = path.join(directory, "installed");
  const alias = path.join(directory, "alias");
  await fs.mkdir(installed);
  const script = path.join(installed, "windows-security-bridge.ps1");
  await fs.writeFile(script, "# synthetic installed script");
  await fs.symlink(installed, alias, "junction");
  const verified = await fs.realpath(script);
  const observed = path.join(alias, path.basename(script));
  expect(observed).not.toBe(verified);
  expect(() => assertInstalledScriptPath(observed, verified)).not.toThrow();
  expect(() => assertInstalledScriptPath(path.toNamespacedPath(observed), verified)).not.toThrow();
});

it("rejects a different script even when its name and bytes match the verified asset", async () => {
  const directory = await tempRoot("fs-safe-proof-script-copy-");
  const installed = path.join(directory, "installed");
  const other = path.join(directory, "other");
  await fs.mkdir(installed);
  await fs.mkdir(other);
  const script = path.join(installed, "windows-security-bridge.ps1");
  const copy = path.join(other, path.basename(script));
  await fs.writeFile(script, "# synthetic installed script");
  await fs.copyFile(script, copy);
  expect(await fs.readFile(copy)).toEqual(await fs.readFile(script));
  expect(() => assertInstalledScriptPath(copy, script))
    .toThrow("production helper must execute the verified installed script");
  expect(() => assertInstalledScriptPath(path.join(directory, "missing.ps1"), script))
    .toThrowError(expect.objectContaining({ code: "ENOENT" }));
});

it.each(["\n", "\r\n"])("retains ordered path-free fixture checkpoints with %j line endings", newline => {
  const stderr = [
    "FS_SAFE_SECURITY_FIXTURE:script:start:0",
    "FS_SAFE_SECURITY_FIXTURE:add-type:start:1",
    "unrelated diagnostic with C:\\private\\fixture.ps1",
    "FS_SAFE_SECURITY_FIXTURE:private-path:start:2",
    "FS_SAFE_SECURITY_FIXTURE:add-type:end:500",
    "FS_SAFE_SECURITY_FIXTURE:get-acl:start:501",
  ].join(newline) + newline;
  expect(windowsSecurityFixturePhases(stderr)).toEqual([
    { step: "script:start", childElapsedMs: 0 },
    { step: "add-type:start", childElapsedMs: 1 },
    { step: "add-type:end", childElapsedMs: 500 },
    { step: "get-acl:start", childElapsedMs: 501 },
  ]);
});

it("bounds fixture diagnostics and ignores malformed or absent markers", () => {
  const marker = "FS_SAFE_SECURITY_FIXTURE:script:start:0\n";
  expect(windowsSecurityFixturePhases(marker.repeat(100))).toHaveLength(16);
  expect(windowsSecurityFixturePhases("x".repeat(1024 * 1024) + "\n" + marker)).toEqual([]);
  expect(windowsSecurityFixturePhases([
    "FS_SAFE_SECURITY_FIXTURE:script:start:-1",
    "FS_SAFE_SECURITY_FIXTURE:script:start:1.5",
    "FS_SAFE_SECURITY_FIXTURE:script:start:9999999999",
    "FS_SAFE_SECURITY_FIXTURE:script:start:1 trailing data",
  ].join("\n"))).toEqual([]);
  expect(windowsSecurityFixturePhases(null)).toEqual([]);
});
