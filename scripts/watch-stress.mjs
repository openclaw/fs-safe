#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { scale, churn, soak } from "./watch-stress/workloads.mjs";
import { fanout, lifecycle, adversarial } from "./watch-stress/lifecycle.mjs";
import { idle, limits, limitChild } from "./watch-stress/platform.mjs";
import { errorInfo, diagnostics } from "./watch-stress/oracle.mjs";
import { selftest } from "./watch-stress/selftest.mjs";

const scenarios = { scale, fanout, churn, lifecycle, adversarial, limits, idle, soak };
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--scenario" || ![...Object.keys(scenarios), "all", "limits-child", "oracle-selftest"].includes(args[1])) {
  process.stderr.write(`Usage: node scripts/watch-stress.mjs --scenario <${Object.keys(scenarios).join("|")}|all>\n`);
  process.exit(2);
}
process.env.NODE_ENV = "test";
const selected = args[1];
if (selected === "all") {
  for (const name of Object.keys(scenarios)) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--scenario", name], { stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve(signal ? 1 : code)); });
    if (code !== 0) { process.exitCode = code ?? 1; break; }
  }
} else {
  const unhandled = [];
  process.on("unhandledRejection", error => { unhandled.push(errorInfo(error)); });
  const started = performance.now();
  let metrics, failure;
  try { metrics = await (selected === "limits-child" ? limitChild : selected === "oracle-selftest" ? selftest : scenarios[selected])(); }
  catch (error) { failure = errorInfo(error); }
  await delay(100);
  if (unhandled.length && !failure) failure = { message: "unhandled promise rejections" };
  if (diagnostics.cleanupErrors.length && !failure) failure = { message: "cleanup failed", errors: diagnostics.cleanupErrors };
  process.stdout.write(JSON.stringify({ scenario: selected, result: failure ? "fail" : "pass", platform: process.platform,
    arch: process.arch, node: process.version, durationMs: performance.now() - started,
    metrics: metrics ?? { diagnostics, rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024 }, failure, unhandled }) + "\n");
  if (failure) process.exitCode = 1;
}
