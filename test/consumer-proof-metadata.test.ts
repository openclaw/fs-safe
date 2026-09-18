import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nativeBinaryLoaded, packageProofSource, windowsSecurityFixturePhases } from "../scripts/consumer-proof-metadata.mjs";
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
