#!/usr/bin/env node
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

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

const tscBin = resolveTypeScriptCompiler();
if (!tscBin || !existsSync(tscBin)) {
  throw new Error("TypeScript compiler is unavailable; run pnpm install before packing");
}

rmSync("dist", { recursive: true, force: true });
const result = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json"], {
  stdio: "inherit",
  env: process.env,
});
if (result.status !== 0) process.exit(result.status ?? 1);
await import("./build-archive-wasm.mjs");
