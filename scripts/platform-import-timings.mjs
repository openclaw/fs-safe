import { execFileSync } from "node:child_process";
import fs from "node:fs";
const reports = [];
for (const subpath of ["advanced", "file-lock", "permissions", "test-hooks"]) {
  const samplesMs = Array.from({ length: 5 }, () => Number(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const start = performance.now();
    await import('@openclaw/fs-safe/${subpath}');
    console.log(performance.now() - start);
  `], { encoding: "utf8", env: { ...process.env, FS_SAFE_NATIVE_MODE: "off" } }).trim()));
  const report = { runtime: process.versions.bun ? "Bun" : "Node", version: process.version,
    subpath, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[2] };
  reports.push(report);
  console.log(JSON.stringify(report));
}
fs.mkdirSync("artifacts-platform-imports", { recursive: true });
fs.writeFileSync(`artifacts-platform-imports/${process.versions.bun ? "bun" : "node"}-${process.arch}.json`, JSON.stringify(reports, null, 2) + "\n");
