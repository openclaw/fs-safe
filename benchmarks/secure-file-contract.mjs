import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export function measuredSecureFileFeatures(dist) {
  // Inspect the measured build, including an arbitrary --dist, not this checkout
  // or its optional addon: old JavaScript still has the pathname-ACL contract.
  return {
    windowsSecureFileDescriptorAcl: fs.existsSync(path.join(dist, "secure-file-windows.js")),
    windowsSecureFileCommandAcl: fs.existsSync(path.join(dist, "windows-security-command.js")),
  };
}

export function secureFileBenchmarkCase({ platform, measuredFeatures, binding, nativeMode }, expectedBytes) {
  assert.equal(typeof measuredFeatures?.windowsSecureFileDescriptorAcl, "boolean",
    "The measured distribution's secure-file contract must be explicit");
  assert.equal(typeof measuredFeatures?.windowsSecureFileCommandAcl, "boolean",
    "The measured distribution's secure-file command contract must be explicit");
  assert(["off", "auto", "require"].includes(nativeMode), "The configured native mode must be explicit");
  const windows = platform === "win32";
  const descriptorAcl = measuredFeatures.windowsSecureFileDescriptorAcl;
  const nativeDescriptorAcl = typeof binding?.inspectWindowsSecureFileHandle === "function";
  const commandDescriptorAcl = measuredFeatures.windowsSecureFileCommandAcl && nativeMode !== "require";
  const expectError = windows && descriptorAcl && !nativeDescriptorAcl && !commandDescriptorAcl;
  const name = !windows ? "readSecureFile"
    : !descriptorAcl ? "readSecureFile/legacy-pathname-acl"
    : expectError ? "readSecureFile/permission-unverified"
    : nativeDescriptorAcl ? "readSecureFile/descriptor-acl"
    : "readSecureFile/command-descriptor-acl";
  return {
    name,
    expectError,
    verify: (result) => {
      if (expectError) {
        assert.equal(result?.code, "permission-unverified");
        return;
      }
      assert.deepEqual(result.buffer, expectedBytes);
      if (windows && descriptorAcl) {
        const permissions = result.permissions;
        assert.equal(permissions?.ok, true);
        assert.equal(permissions.source, "windows-acl");
        assert.equal(permissions.ownerTrusted, true);
        for (const field of ["isSymlink", "isDir", "worldWritable", "groupWritable", "worldReadable", "groupReadable"]) {
          assert.equal(permissions[field], false);
        }
        assert.match(permissions.aclSummary, nativeDescriptorAcl
          ? /^native descriptor owner=/u : /^system-command descriptor owner=/u);
      }
    },
  };
}
