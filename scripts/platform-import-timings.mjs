import { execFileSync } from "node:child_process";
for (const subpath of ["file-lock", "permissions", "test-hooks"]) {
  const samplesMs = Array.from({ length: 5 }, () => Number(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const start = performance.now();
    await import('@openclaw/fs-safe/${subpath}');
    console.log(performance.now() - start);
  `], { encoding: "utf8", env: { ...process.env, FS_SAFE_NATIVE_MODE: "off" } }).trim()));
  console.log(JSON.stringify({ runtime: process.versions.bun ? "Bun" : "Node", version: process.version,
    subpath, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[2] }));
}
