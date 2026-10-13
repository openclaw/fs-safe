import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { renderNodeBaseline } from "../benchmarks/node-baseline-report.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("samples independent builds equally and retains a control for each build", async () => {
  const directory = await tempRoot("fs-safe-benchmark-builds-");
  const calls = path.join(directory, "calls.jsonl");
  const report = path.join(directory, "report.json");
  for (const label of ["baseline", "candidate"]) {
    const root = path.join(directory, label);
    const dist = path.join(root, "dist");
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    for (const name of ["index", "root", "advanced", "atomic", "json", "store", "file-lock", "temp", "walk", "archive", "durability"]) {
      await fs.writeFile(path.join(dist, `${name}.js`), "export {};\n");
    }
    await fs.writeFile(path.join(dist, "native.js"), "export const getNativeBinding = () => undefined;\n");
    // A synthetic API records harness calls; it is not a filesystem-safety proof.
    await fs.writeFile(path.join(dist, "advanced.js"), `
      import fs from "node:fs";
      import { createHash } from "node:crypto";
      export const configureFsSafeNative = () => {};
      export const getFsSafeNativeConfig = () => ({ mode: "off" });
      export const root = async () => ({});
      export const jsonStore = () => ({});
      export const createIcaclsResetCommand = () => ({ command: process.execPath, args: ["-e", ""] });
      function hash(file, kind) {
        fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ label: ${JSON.stringify(label)}, kind }) + "\\n");
        return { digest: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
      }
      export const sha256File = async file => hash(file, "async");
      export const sha256FileSync = file => hash(file, "sync");
    `);
  }
  execFileSync(process.execPath, [
    path.resolve("benchmarks/node-baseline.mjs"), "--mode", "off", "--filter", "hash",
    "--iterations", "2", "--samples", "2", "--warmup", "1",
    "--dist", path.join(directory, "candidate/dist"),
    "--compare-dist", path.join(directory, "baseline/dist"), "--json", report,
  ], { stdio: "pipe", timeout: 60_000 });
  const observed = (await fs.readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const kind of ["async", "sync"]) {
    const count = (label: string) => observed.filter(call => call.kind === kind && call.label === label).length;
    expect(count("baseline")).toBeGreaterThan(0);
    expect(count("candidate")).toBe(count("baseline"));
  }
  const comparison = JSON.parse(await fs.readFile(report, "utf8"));
  for (const row of comparison.results) {
    expect(row.samples.rawControl).toHaveLength(2);
    expect(row.samples.safeControl).toHaveLength(2);
    expect(row.candidateAa).toMatchObject({ rawNs: row.safeNs });
  }
  expect(renderNodeBaseline([comparison])).toContain("Candidate A/A off");
  const rawReport = path.join(directory, "raw-report.json");
  execFileSync(process.execPath, [
    path.resolve("benchmarks/node-baseline.mjs"), "--mode", "off", "--filter", "hash",
    "--iterations", "2", "--samples", "2", "--warmup", "1",
    "--dist", path.join(directory, "candidate/dist"), "--json", rawReport,
  ], { stdio: "pipe", timeout: 60_000 });
  const raw = JSON.parse(await fs.readFile(rawReport, "utf8"));
  for (const row of raw.results) {
    expect(row.samples.rawControl).toHaveLength(2);
    expect(row.samples.safeControl).toBeUndefined();
    expect(row.candidateAa).toBeUndefined();
  }
  expect(renderNodeBaseline([raw])).not.toContain("Candidate A/A");
}, 60_000);
