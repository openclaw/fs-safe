const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const tracePath = process.env.FS_SAFE_SIDECAR_TRACE_PATH;
globalThis.__fsSafeTrace = phase => fs.appendFileSync(tracePath, JSON.stringify({
  usage: process.resourceUsage(), phase, ms: performance.now(), wall: Date.now(), cpu: process.cpuUsage(),
  nodeTiming: phase === "imports-complete" ? performance.nodeTiming.toJSON() : undefined,
}) + "\n", { mode: 0o600 });
globalThis.__fsSafeTrace("preload");
process.on("exit", () => globalThis.__fsSafeTrace("exit"));
