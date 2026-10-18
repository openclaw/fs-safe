import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { compilerEnvironment, runProcess } from "../scripts/compiler-qualification.mjs";
import { cleanHelperOutputs, preservePackage, redact } from "../scripts/compiler-platform-qualification.mjs";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("clears compiler tuning with Windows environment casing without changing unrelated input", () => {
  const input = { tSc_Ts_BuNdLeD_LiBs: "1", GoGc: "off", PATH: "unchanged" };
  expect(compilerEnvironment(input).env).toEqual({ PATH: "unchanged" });
  expect(input.GoGc).toBe("off");
});

it("redacts nested diagnostics with native and portable Windows path spellings", () => {
  expect(redact({ log: ["C:\\Runner Space\\work\\a.ts", "c:/runner space/work/b.ts"] },
    [["C:\\Runner Space\\work", "<repo>"]])).toEqual({ log: ["<repo>\\a.ts", "<repo>/b.ts"] });
});

it("cleans only helper build outputs and preserves source, staged output and caches", async () => {
  const root = await tempRoot("clean compiler outputs-");
  for (const name of ["native/windows-security-helper/bin/output.exe", "native/windows-security-helper/obj/cache",
    "native/windows-security-helper/Program.cs", "src/windows-security-helper.exe", "node_modules/cache", "target/cache"]) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name);
  }
  cleanHelperOutputs(root);
  expect(fs.existsSync(path.join(root, "native/windows-security-helper/bin"))).toBe(false);
  expect(fs.existsSync(path.join(root, "native/windows-security-helper/obj"))).toBe(false);
  for (const name of ["native/windows-security-helper/Program.cs", "src/windows-security-helper.exe",
    "node_modules/cache", "target/cache"]) {
    expect(fs.readFileSync(path.join(root, name), "utf8")).toBe(name);
  }
});

it("rejects package proof that rewrites the selected compiler output", async () => {
  const root = await tempRoot("package custody-");
  fs.mkdirSync(path.join(root, "dist"));
  const file = path.join(root, "dist/index.js");
  fs.writeFileSync(file, "candidate");
  expect(() => preservePackage(root, () => fs.writeFileSync(file, "official"))).toThrow("differ");
  expect(() => preservePackage(root, () => { throw new Error("package failed"); })).toThrow("package failed");
});

async function fixture(failure = "") {
  const root = await tempRoot("build owner with spaces-");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.resolve("scripts/prepack-build.mjs"), path.join(root, "scripts/prepack-build.mjs"));
  fs.mkdirSync(path.join(root, "node_modules/typescript"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/typescript/package.json"),
    JSON.stringify({ bin: { tsc: "compiler.cjs" } }));
  const record = (stage: string) => `const fs = require("node:fs");
fs.appendFileSync("calls", JSON.stringify({stage:"${stage}",args:process.argv.slice(2)})+"\\n");
if ("${failure}" === "${stage}") process.exit(7);\n`;
  fs.writeFileSync(path.join(root, "node_modules/typescript/compiler.cjs"), record("compiler"));
  for (const [file, stage] of [["build-windows-helper", "helper"], ["build-archive-wasm", "wasm"]]) {
    fs.writeFileSync(path.join(root, `scripts/${file}.mjs`),
      'import { createRequire } from "node:module"; const require=createRequire(import.meta.url);\n' + record(stage));
  }
  return { root, invoke: (args: string[] = []) => runProcess(process.execPath,
    ["scripts/prepack-build.mjs", ...args], { cwd: root }),
  calls: () => fs.readFileSync(path.join(root, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

it("keeps default compiler and helper behavior while isolating the WASM CLI", async () => {
  const f = await fixture();
  expect(f.invoke().status).toBe(0);
  expect(f.calls()).toEqual([
    { stage: "compiler", args: ["-p", "tsconfig.json"] },
    { stage: "helper", args: ["--if-available"] },
    { stage: "wasm", args: [] },
  ]);
});

it("requires a real helper build in qualification instead of the staged fallback", async () => {
  const f = await fixture("helper");
  expect(f.invoke(["--require-toolchains"]).status).toBe(7);
  expect(f.calls().at(-1)).toEqual({ stage: "helper", args: [] });
});

for (const stage of ["compiler", "helper", "wasm"]) {
  it(`fails when the ${stage} fails and does not run later stages`, async () => {
    const f = await fixture(stage);
    expect(f.invoke().status).toBe(7);
    expect(f.calls().at(-1).stage).toBe(stage);
  });
}

it("rejects an unavailable compiler before removing existing dist", async () => {
  const f = await fixture();
  fs.mkdirSync(path.join(f.root, "dist"));
  fs.writeFileSync(path.join(f.root, "dist/retained"), "keep");
  expect(f.invoke(["--compiler", path.join(f.root, "missing compiler")]).status).not.toBe(0);
  expect(fs.readFileSync(path.join(f.root, "dist/retained"), "utf8")).toBe("keep");
});

itPosix("passes a native compiler path containing spaces without forwarding owner flags", async () => {
  const f = await fixture();
  const compiler = path.join(f.root, "native compiler");
  fs.writeFileSync(compiler, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("native-args",JSON.stringify(process.argv.slice(2)));\n',
    { mode: 0o700 });
  expect(f.invoke(["--compiler", compiler, "--require-toolchains"]).status).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, "native-args"), "utf8"))).toEqual(["-p", "tsconfig.json"]);
  expect(f.calls()).toEqual([{ stage: "helper", args: [] }, { stage: "wasm", args: [] }]);
});
