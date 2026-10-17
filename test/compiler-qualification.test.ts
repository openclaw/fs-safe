import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { assertSame, balancedOrder, inputInventory, inventory, qualify, runProcess } from "../scripts/compiler-qualification.mjs";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("keeps nonzero exit status instead of treating a fast failure as success", () => {
  const result = runProcess(process.execPath, ["-e", "process.exitCode = 7"]);
  expect(result.status).toBe(7);
});

it("rejects timeouts and output overflow before parsing output", () => {
  for (const [source, options] of [
    ["setInterval(() => {}, 1000)", { timeout: 100 }],
    ['process.stdout.write("x".repeat(100000))', { maxBuffer: 16 }],
  ] as const) {
    expect(() => runProcess(process.execPath, ["-e", source], options)).toThrow("did not complete");
  }
});

itPosix("rejects a signalled child", () => {
  expect(() => runProcess(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")']))
    .toThrow("did not complete");
});

it("keeps spaces and drive-like colons inside individual arguments", () => {
  const args = ["directory with spaces", "C:\\source files\\entry.ts(1,14)"];
  const result = runProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args]);
  expect(JSON.parse(result.stdout)).toEqual(args);
});

it("uses complete ABBA/BAAB blocks with equal sample counts", () => {
  const order = balancedOrder(10);
  expect(order.slice(0, 8)).toEqual(["official", "candidate", "candidate", "official", "candidate", "official", "official", "candidate"]);
  expect(order.filter((arm: string) => arm === "official")).toHaveLength(10);
  expect(order.filter((arm: string) => arm === "candidate")).toHaveLength(10);
  expect(() => balancedOrder(3)).toThrow("even integers");
});

it("detects changed signatures, missing files, and extra stale output", async () => {
  const directory = await tempRoot("compiler-artifacts-");
  const file = path.join(directory, "index.d.ts");
  fs.writeFileSync(file, "export declare const value: string;\n");
  const baseline = inventory(directory);
  fs.writeFileSync(file, "export declare const value: number;\n");
  expect(() => assertSame(inventory(directory), baseline, "artifacts")).toThrow("differ");
  fs.unlinkSync(file);
  expect(() => assertSame(inventory(directory), baseline, "artifacts")).toThrow("differ");
  fs.writeFileSync(file, "export declare const value: string;\n");
  fs.writeFileSync(path.join(directory, "stale.js"), "");
  expect(() => assertSame(inventory(directory), baseline, "artifacts")).toThrow("differ");
});

it("requires real, unique source and pinned library inputs", async () => {
  const root = await tempRoot("compiler-inputs-");
  const library = path.join(root, "lib");
  fs.mkdirSync(library);
  fs.mkdirSync(path.join(root, "src"));
  const source = path.join(root, "src", "entry.ts");
  const lib = path.join(library, "lib.d.ts");
  fs.writeFileSync(source, "export {};\n");
  fs.writeFileSync(lib, "interface Object {}\n");
  const listed = `${source}\n${lib}\n`;
  const baseline = inputInventory(listed, root, library);
  expect(() => inputInventory(source, root, library)).toThrow("pinned library");
  expect(() => inputInventory(`${listed}${source}\n`, root, library)).toThrow("duplicate");
  fs.writeFileSync(lib, "interface Object { changed: true }\n");
  expect(() => assertSame(inputInventory(listed, root, library), baseline, "inputs")).toThrow("differ");
  fs.unlinkSync(source);
  expect(() => inputInventory(listed, root, library)).toThrow();
});

// The fake native executables exercise orchestration and evidence custody. Real
// compiler parity is a separate experiment; these tests never claim that proof.
async function compilerFixture(behavior = "normal") {
  const root = await tempRoot("compiler campaign with spaces-");
  const nodeModules = path.join(root, "node_modules");
  const officialPackage = path.join(nodeModules, "typescript");
  const platformName = `@typescript/typescript-${process.platform}-${process.arch}`;
  const platformPackage = path.join(nodeModules, platformName);
  const library = path.join(platformPackage, "lib");
  fs.mkdirSync(officialPackage, { recursive: true });
  fs.mkdirSync(library, { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"declaration":true}}');
  fs.writeFileSync(path.join(root, "src", "entry.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(officialPackage, "package.json"), JSON.stringify({ name: "typescript", version: "7.0.2" }));
  fs.writeFileSync(path.join(platformPackage, "package.json"), JSON.stringify({ name: platformName, version: "7.0.2" }));
  fs.writeFileSync(path.join(library, "lib.d.ts"), "interface Object {}\n");
  const candidate = path.join(root, "candidate.cjs");
  function executable(file: string, variant: string) {
    fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const variant = ${JSON.stringify(variant)};
const root = ${JSON.stringify(root)};
const library = ${JSON.stringify(library)};
const project = args.includes("-p") ? args[args.indexOf("-p") + 1] : "";
if (args.includes("--version")) console.log("Version 7.0.2");
else if (args.includes("--showConfig")) console.log(JSON.stringify({compilerOptions:{declaration:true}}));
else if (args.includes("--listFilesOnly")) {
  if (variant === "final-input-mutation") {
    const marker = path.join(root,"enumerated");
    if (fs.existsSync(marker)) fs.appendFileSync(path.join(root,"tsconfig.json")," ");
    fs.writeFileSync(marker,"");
  }
  console.log(path.join(root,"src","entry.ts") + "\\n" + path.join(library,"lib.d.ts"));
}
else if (project.includes("fixture")) {
  if (fs.readFileSync(path.join(path.dirname(project),"entry.ts"),"utf8").includes("= 1")) {
    if (variant !== "false-success") {
      console.log(path.join(path.dirname(project),"entry.ts") + "(1,14): error TS2322: Type 'number' is not assignable to type 'string'.");
      process.exitCode = 2;
    }
  }
} else if (args.includes("--outDir")) {
  const out = args[args.indexOf("--outDir") + 1];
  if (variant !== "empty-output") {
    fs.writeFileSync(path.join(out,"entry.js"),"export const value = 1;\\n");
    fs.writeFileSync(path.join(out,"entry.d.ts"), variant === "bad-declaration" ? "export declare const value: string;\\n" : "export declare const value = 1;\\n");
  }
  if (variant === "mutate-source") fs.appendFileSync(path.join(root,"src","entry.ts"),"// changed\\n");
  if (variant === "mutate-retained" && out.includes("measured")) fs.writeFileSync(path.join(path.dirname(out),"official","entry.d.ts"),"changed");
  if (variant === "fail-measured" && out.includes("measured")) process.exitCode = 7;
}
`, { mode: 0o700 });
  }
  executable(path.join(library, "tsc"), "normal");
  executable(candidate, behavior);
  return { root, candidate, output: path.join(root, "evidence"), runs: 2, warmup: 2 };
}

itPosix("records two modes and excludes warmups from measured sample counts", async () => {
  const options = await compilerFixture();
  const report = qualify(options);
  expect(report.status, report.failure).toBe("pass");
  expect(report.samples.filter((sample: { phase: string }) => sample.phase === "measured")).toHaveLength(8);
  expect(report.samples.filter((sample: { phase: string }) => sample.phase === "warmup")).toHaveLength(8);
  expect(report.processes.some((run: { status: number }) => run.status === 2)).toBe(true);
  expect(fs.readdirSync(options.output).sort()).toEqual(["candidate", "fixture", "official", "report.json"]);
  expect(fs.readFileSync(path.join(options.output, "report.json"), "utf8")).not.toContain(options.root);
  expect(() => qualify(options)).toThrow();
  expect(fs.existsSync(path.join(options.output, "report.json"))).toBe(true);
}, 15_000);

for (const [behavior, failure] of [
  ["false-success", "invalid diagnostics differ"],
  ["empty-output", "missing JavaScript or declaration output"],
  ["bad-declaration", "emitted artifacts differ"],
  ["mutate-source", "final resolved inputs differ"],
  ["final-input-mutation", "campaign identities before and after execution differ"],
  ["mutate-retained", "retained emitted artifacts differ"],
  ["fail-measured", "emission was not clean"],
]) {
  itPosix(`rejects ${behavior} and records the failure`, async () => {
    const options = await compilerFixture(behavior);
    const report = qualify(options);
    expect(report.status).toBe("fail");
    expect(report.failure).toBe(failure);
    expect(JSON.parse(fs.readFileSync(path.join(options.output, "report.json"), "utf8")).status).toBe("fail");
    if (behavior === "fail-measured") expect(report.processes.at(-1).status).toBe(7);
  }, 15_000);
}

itPosix("rejects a symlinked artifact parent before writing inside source", async () => {
  const options = await compilerFixture();
  const alias = path.join(options.root, "alias");
  fs.symlinkSync(path.join(options.root, "src"), alias, "dir");
  expect(() => qualify({ ...options, output: path.join(alias, "evidence") })).toThrow("unsafe artifact destination");
  expect(fs.existsSync(path.join(options.root, "src", "evidence"))).toBe(false);
});

itPosix("rejects internally matching packages with a different frozen version", async () => {
  const options = await compilerFixture();
  for (const name of ["typescript", `@typescript/typescript-${process.platform}-${process.arch}`]) {
    fs.writeFileSync(path.join(options.root, "node_modules", name, "package.json"), JSON.stringify({ name, version: "7.0.3" }));
  }
  const report = qualify(options);
  expect(report.status).toBe("fail");
  expect(report.failure).toBe("official compiler packages do not match");
  expect(report.processes).toHaveLength(0);
});
