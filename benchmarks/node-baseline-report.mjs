import assert from "node:assert/strict";

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

// strace timings are intentionally never used as latency measurements.
export function parseSyscalls(trace) {
  const result = {};
  let active;
  for (const line of trace.split("\n")) {
    const marker = /TRACE_(START|END) ([\w/-]+) (raw|safe)/u.exec(line);
    if (marker) {
      const key = `${marker[2]}/${marker[3]}`;
      if (marker[1] === "START") {
        assert.equal(active, undefined, "Overlapping trace windows");
        assert(!result[key], `Duplicate trace window ${key}`);
        result[key] = {};
        active = key;
      } else {
        assert.equal(active, key, "Mismatched trace window");
        active = undefined;
      }
      continue;
    }
    if (!active || /anon_inode:|pipe:\[|socket:\[/u.test(line)) continue;
    const syscall = /^\s*(?:\[pid\s+\d+\]|\d+)\s+(\w+)\(/u.exec(line)?.[1];
    if (syscall) result[active][syscall] = (result[active][syscall] ?? 0) + 1;
  }
  assert.equal(active, undefined, "Unclosed trace window");
  return result;
}

export function renderNodeBaseline(reports) {
  assert(reports.length > 0);
  const lines = ["# Node / fs-safe baseline", "",
    "Raw Node baselines are NOT security-equivalent. Ratios are fs-safe/raw median ns/op; lower is faster. A/A compares identical raw calls, and exposes noise, not a correction factor.", ""];
  for (const report of reports) {
    const m = report.metadata;
    lines.push(`${m.platform}/${m.arch}, Node ${m.node}, package ${m.packageVersion}, mode ${m.mode}, filesystem ${m.filesystem}, ${m.samples} alternating blocks (median sample means).`, "");
  }
  lines.push("| Operation | Raw off ns/op | Safe off ns/op | off/raw | A/A off | Raw require ns/op | Safe require ns/op | require/raw | A/A require |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  const names = [...new Set(reports.flatMap((r) => r.results.map((row) => row.operation)))];
  const format = (value, ratio = false) => value === undefined ? "—" : ratio ? `${value.toFixed(2)}×` : Math.round(value).toLocaleString("en-US");
  for (const name of names) {
    const cells = [name];
    for (const mode of ["off", "require"]) {
      const row = reports.find((r) => r.metadata.mode === mode)?.results.find((r) => r.operation === name);
      cells.push(format(row?.rawNs), format(row?.safeNs), format(row?.ratio, true), format(row?.aa.ratio, true));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("", "Operation comparisons:", "");
  for (const name of names) {
    const row = reports.flatMap((r) => r.results).find((r) => r.operation === name);
    lines.push(`- **${name}:** ${row.caveat}`);
  }
  lines.push("", "Setup, verification, cleanup, and separately observed async resources/syscalls are excluded from timings. Synchronous counterparts are standalone APIs because Root has no synchronous interface. See JSON for samples, actual iterations, native artifact hashes, resource counts, load, and provenance.", "");
  return lines.join("\n");
}
