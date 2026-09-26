import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getNativeBinding } from "../../dist/native.js";
export const exec = promisify(execFile);
export const threads = () => getNativeBinding().watchThreadCount();
export function powershell(source) {
  return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")]);
}
export async function resources() {
  let handles;
  if (process.platform === "linux") handles = (await fs.readdir("/proc/self/fd")).length;
  else if (process.platform === "darwin") {
    const { stdout } = await exec("/usr/sbin/lsof", ["-a", "-p", String(process.pid), "-Ff"]);
    handles = stdout.split("\n").filter(line => /^f\d/.test(line)).length;
  } else {
    const { stdout } = await powershell(`(Get-Process -Id ${process.pid}).HandleCount`);
    handles = Number(stdout.trim());
  }
  return { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, handles, hubThreads: threads() };
}
export async function threadSample() {
  if (process.platform === "linux") {
    const result = [];
    for (const id of await fs.readdir("/proc/self/task")) {
      try {
        const text = await fs.readFile(`/proc/self/task/${id}/status`, "utf8");
        if (!/^Name:\s+fs-safe-watch$/m.test(text)) continue;
        result.push({ id, voluntary: Number(text.match(/^voluntary_ctxt_switches:\s+(\d+)/m)?.[1]), involuntary: Number(text.match(/^nonvoluntary_ctxt_switches:\s+(\d+)/m)?.[1]) });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return result;
  }
  if (process.platform === "darwin") return (await exec("ps", ["-M", "-p", String(process.pid)])).stdout;
  return (await powershell(`(Get-Process -Id ${process.pid}).Threads | Select-Object Id,@{n='CpuMs';e={$_.TotalProcessorTime.TotalMilliseconds}} | ConvertTo-Json -Compress`)).stdout.trim();
}
export const percentile = (values, percentile) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * percentile))];
export function trend(samples) {
  if (samples.length < 2) return { growth: 0, bytesPerSecond: 0 };
  const meanT = samples.reduce((sum, item) => sum + item.seconds, 0) / samples.length;
  const meanR = samples.reduce((sum, item) => sum + item.rss, 0) / samples.length;
  const denominator = samples.reduce((sum, item) => sum + (item.seconds - meanT) ** 2, 0);
  return { growth: samples.at(-1).rss - samples[0].rss,
    bytesPerSecond: samples.reduce((sum, item) => sum + (item.seconds - meanT) * (item.rss - meanR), 0) / denominator };
}
