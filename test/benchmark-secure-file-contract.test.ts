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

it("detects the contract in the selected distribution, including saved current builds", async () => {
  const directory = await tempRoot("fs-safe-benchmark-contract-");
  const baseline = path.join(directory, "baseline", "dist");
  const current = path.join(directory, "saved-current", "dist");
  await fs.mkdir(baseline, { recursive: true });
  await fs.mkdir(current, { recursive: true });
  await fs.writeFile(path.join(baseline, "secure-file.js"), "export {};\n");
  await fs.writeFile(path.join(current, "secure-file-windows.js"), "export {};\n");
  expect(measuredSecureFileFeatures(baseline)).toEqual({ windowsSecureFileDescriptorAcl: false });
  expect(measuredSecureFileFeatures(current)).toEqual({ windowsSecureFileDescriptorAcl: true });
});

describe.each([
  ["off", undefined, false],
  ["require with older helper", {}, false],
  ["require with current helper", { inspectWindowsSecureFileHandle() {} }, true],
] as const)("Windows secure-read benchmarks: %s", (_mode, binding, hasCapability) => {
  it.each([false, true])("checks the measured descriptor contract = %s", (descriptorAcl) => {
    const measured = secureFileBenchmarkCase({
      platform: "win32",
      measuredFeatures: { windowsSecureFileDescriptorAcl: descriptorAcl },
      binding,
    }, payload);
    const rejected = descriptorAcl && !hasCapability;
    expect(measured.name).toBe(!descriptorAcl ? "readSecureFile/legacy-pathname-acl"
      : rejected ? "readSecureFile/permission-unverified" : "readSecureFile/descriptor-acl");
    expect(measured.name.split("/")[0]).toBe("readSecureFile");
    expect(measured.expectError).toBe(rejected);
    if (rejected) {
      expect(() => measured.verify({ code: "permission-unverified" })).not.toThrow();
      expect(() => measured.verify({ code: "path-mismatch" })).toThrow();
      expect(() => measured.verify({ buffer: payload })).toThrow();
    } else {
      expect(() => measured.verify({ buffer: payload })).not.toThrow();
      expect(() => measured.verify({ buffer: Buffer.from("wrong bytes") })).toThrow();
      expect(() => measured.verify({ code: "permission-unverified" })).toThrow();
    }
  });
});

it.each(["linux", "darwin"])("preserves verified successful reads on %s", (platform) => {
  const measured = secureFileBenchmarkCase({
    platform,
    measuredFeatures: { windowsSecureFileDescriptorAcl: true },
    binding: undefined,
  }, payload);
  expect(measured.name).toBe("readSecureFile");
  expect(measured.expectError).toBe(false);
  expect(() => measured.verify({ buffer: payload })).not.toThrow();
});

it("does not infer the JavaScript contract from native capability alone", () => {
  expect(() => secureFileBenchmarkCase({
    platform: "win32",
    binding: { inspectWindowsSecureFileHandle() {} },
  }, payload)).toThrow("must be explicit");
});
