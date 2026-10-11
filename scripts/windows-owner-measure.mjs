// Temporary diagnostic, removed before the PR is ready.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative } from "../dist/native-config.js";
import { inspectPathPermissions } from "../dist/permissions.js";
import { executePermissionCommand } from "../dist/permission-exec.js";
import { encodePowerShellCommand, windowsOwnerQueryCommand } from "../test/helpers/windows-owner-oracle.ts";

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
if (!process.argv[2]) {
  const results = [];
  for (let processIndex = 0; processIndex < 3; processIndex++) {
    for (const mode of ["before", "after"]) {
      const result = JSON.parse(execFileSync(process.execPath, [import.meta.filename, mode], {
        encoding: "utf8", windowsHide: true, timeout: 120_000,
      }));
      results.push({ processIndex, ...result });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  const before = median(results.filter(row => row.mode === "before").flatMap(row => row.samples));
  const after = median(results.filter(row => row.mode === "after").flatMap(row => row.samples));
  console.log(JSON.stringify({ beforeMedianMs: before, afterMedianMs: after, speedup: before / after }));
} else {
  configureFsSafeNative({ mode: "off" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-owner-timing-"));
  try {
    const target = path.join(root, "fixture.txt");
    await fs.writeFile(target, "synthetic timing fixture");
    const mode = process.argv[2];
    const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const options = mode === "before" ? { exec: (_command, args) => executePermissionCommand(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(windowsOwnerQueryCommand(args[1])),
    ]) } : undefined;
    const samples = [];
    for (let index = 0; index < 20; index++) {
      const start = performance.now();
      const result = await inspectPathPermissions(target, options);
      samples.push(performance.now() - start);
      assert.equal(result.source, "windows-acl");
      assert.equal(result.ownerTrusted, true);
      assert.equal(result.ok, true);
    }
    console.log(JSON.stringify({ mode, samples, medianMs: median(samples) }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
