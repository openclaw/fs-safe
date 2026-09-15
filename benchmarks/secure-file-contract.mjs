import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export function measuredSecureFileFeatures(dist) {
  // Inspect the measured build, including an arbitrary --dist, not this checkout
  // or its optional addon: old JavaScript still has the pathname-ACL contract.
  return {
    windowsSecureFileDescriptorAcl: fs.existsSync(path.join(dist, "secure-file-windows.js")),
  };
}

export function secureFileBenchmarkCase({ platform, measuredFeatures, binding }, expectedBytes) {
  assert.equal(typeof measuredFeatures?.windowsSecureFileDescriptorAcl, "boolean",
    "The measured distribution's secure-file contract must be explicit");
  const windows = platform === "win32";
  const descriptorAcl = measuredFeatures.windowsSecureFileDescriptorAcl;
  const expectError = windows && descriptorAcl &&
    typeof binding?.inspectWindowsSecureFileHandle !== "function";
  const name = !windows ? "readSecureFile"
    : !descriptorAcl ? "readSecureFile/legacy-pathname-acl"
    : expectError ? "readSecureFile/permission-unverified"
    : "readSecureFile/descriptor-acl";
  return {
    name,
    expectError,
    verify: (result) => {
      if (expectError) assert.equal(result?.code, "permission-unverified");
      else assert.deepEqual(result.buffer, expectedBytes);
    },
  };
}
