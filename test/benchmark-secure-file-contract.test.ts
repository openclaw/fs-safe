import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  measuredSecureFileFeatures,
  secureFileBenchmarkCase,
} from "../benchmarks/secure-file-contract.mjs";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const payload = Buffer.from("synthetic benchmark bytes");
const contracts = {
  legacy: { windowsSecureFileDescriptorAcl: false, windowsSecureFileCommandAcl: false },
  descriptor: { windowsSecureFileDescriptorAcl: true, windowsSecureFileCommandAcl: false },
  command: { windowsSecureFileDescriptorAcl: true, windowsSecureFileCommandAcl: true },
};
const nativeBinding = { inspectWindowsSecureFileHandle() {} };

it("distinguishes legacy, descriptor-only, and command-capable saved distributions", async () => {
  const directory = await tempRoot("fs-safe-benchmark-contract-");
  for (const [name, features] of Object.entries(contracts)) {
    const dist = path.join(directory, name, "dist");
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, "secure-file.js"), "export {};\n");
    if (features.windowsSecureFileDescriptorAcl) {
      await fs.writeFile(path.join(dist, "secure-file-windows.js"), "export {};\n");
    }
    if (features.windowsSecureFileCommandAcl) {
      await fs.writeFile(path.join(dist, "windows-security-command.js"), "export {};\n");
    }
    expect(measuredSecureFileFeatures(dist)).toEqual(features);
  }
});

describe.each([
  ["off", "off", undefined, "permission-unverified", "command-descriptor-acl"],
  ["auto without helper", "auto", undefined, "permission-unverified", "command-descriptor-acl"],
  ["auto with older helper", "auto", {}, "permission-unverified", "command-descriptor-acl"],
  ["auto with current helper", "auto", nativeBinding, "descriptor-acl", "descriptor-acl"],
  ["require without helper", "require", undefined, "permission-unverified", "permission-unverified"],
  ["require with older helper", "require", {}, "permission-unverified", "permission-unverified"],
  ["require with current helper", "require", nativeBinding, "descriptor-acl", "descriptor-acl"],
] as const)("Windows secure-read benchmarks: %s", (_label, nativeMode, binding, descriptorName, commandName) => {
  it.each([
    ["legacy", "legacy-pathname-acl"], ["descriptor", descriptorName], ["command", commandName],
  ] as const)("checks the measured %s contract", (contract, expectedName) => {
    const measured = secureFileBenchmarkCase({
      platform: "win32",
      measuredFeatures: contracts[contract],
      binding,
      nativeMode,
    }, payload);
    const rejected = expectedName === "permission-unverified";
    expect(measured.name).toBe(`readSecureFile/${expectedName}`);
    expect(measured.name.split("/")[0]).toBe("readSecureFile");
    expect(measured.expectError).toBe(rejected);
    if (rejected) {
      expect(() => measured.verify({ code: "permission-unverified" })).not.toThrow();
      expect(() => measured.verify({ code: "path-mismatch" })).toThrow();
      expect(() => measured.verify({ buffer: payload })).toThrow();
    } else {
      const permissions = {
        ok: true, source: "windows-acl", ownerTrusted: true,
        isSymlink: false, isDir: false,
        worldWritable: false, groupWritable: false, worldReadable: false, groupReadable: false,
        aclSummary: `${expectedName === "command-descriptor-acl" ? "system-command" : "native"} descriptor owner=current-user world=-- group=--`,
      };
      const result = { buffer: payload, permissions };
      expect(() => measured.verify(result)).not.toThrow();
      expect(() => measured.verify({ ...result, buffer: Buffer.from("wrong bytes") })).toThrow();
      expect(() => measured.verify({ code: "permission-unverified" })).toThrow();
      if (contract !== "legacy") {
        expect(() => measured.verify({ buffer: payload })).toThrow();
        for (const invalid of [
          { ok: false }, { source: "unknown" }, { ownerTrusted: false },
          { isSymlink: true }, { isDir: true },
          { worldWritable: true }, { groupWritable: true }, { worldReadable: true }, { groupReadable: true },
          { aclSummary: "pathname owner=current-user" },
          { aclSummary: `${expectedName === "command-descriptor-acl" ? "native" : "system-command"} descriptor owner=current-user` },
        ]) {
          expect(() => measured.verify({ ...result, permissions: { ...permissions, ...invalid } })).toThrow();
        }
      }
    }
  });
});

it.each(["linux", "darwin"])("preserves verified successful reads on %s", (platform) => {
  const measured = secureFileBenchmarkCase({
    platform,
    measuredFeatures: contracts.command,
    binding: undefined,
    nativeMode: "off",
  }, payload);
  expect(measured.name).toBe("readSecureFile");
  expect(measured.expectError).toBe(false);
  expect(() => measured.verify({ buffer: payload })).not.toThrow();
});

it("does not infer the JavaScript contract from native capability alone", () => {
  expect(() => secureFileBenchmarkCase({
    platform: "win32",
    binding: nativeBinding,
    nativeMode: "auto",
  }, payload)).toThrow("must be explicit");
});

it("requires explicit command support and native mode rather than assuming fallback success", () => {
  expect(() => secureFileBenchmarkCase({
    platform: "win32",
    measuredFeatures: { windowsSecureFileDescriptorAcl: true },
    nativeMode: "off",
  }, payload)).toThrow("command contract must be explicit");
  expect(() => secureFileBenchmarkCase({
    platform: "win32",
    measuredFeatures: contracts.command,
  }, payload)).toThrow("native mode must be explicit");
});
