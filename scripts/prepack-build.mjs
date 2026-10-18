#!/usr/bin/env node
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);

function resolveTypeScriptCompiler() {
  try {
    const packageJsonPath = require.resolve("typescript/package.json");
    const packageJson = require(packageJsonPath);
    const compilerPath = packageJson.bin?.tsc;
    return typeof compilerPath === "string"
      ? resolve(dirname(packageJsonPath), compilerPath)
      : undefined;
  } catch {
    return undefined;
  }
}

const { values } = parseArgs({ options: {
  compiler: { type: "string" },
  "require-toolchains": { type: "boolean", default: false },
} });
const tscBin = values.compiler ? resolve(values.compiler) : resolveTypeScriptCompiler();
if (!tscBin || !existsSync(tscBin)) {
  throw new Error("TypeScript compiler is unavailable; run pnpm install before packing");
}

rmSync("dist", { recursive: true, force: true });
const result = spawnSync(values.compiler ? tscBin : process.execPath,
  [...(values.compiler ? [] : [tscBin]), "-p", "tsconfig.json"], {
  stdio: "inherit",
  env: process.env,
});
if (result.status !== 0) process.exit(result.status ?? 1);
const helper = spawnSync(process.execPath, ["scripts/build-windows-helper.mjs",
  ...(values["require-toolchains"] ? [] : ["--if-available"])], { stdio: "inherit" });
if (helper.status !== 0) process.exit(helper.status ?? 1);
// Keep build-owner options out of the WASM script's independent CLI.
const wasm = spawnSync(process.execPath, ["scripts/build-archive-wasm.mjs"], { stdio: "inherit" });
if (wasm.status !== 0) process.exit(wasm.status ?? 1);
