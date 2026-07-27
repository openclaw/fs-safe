#!/usr/bin/env node
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
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

const nativeDirectory = resolve("dist/native");
const heldNativeDirectory = resolve(".fs-safe-prepack-native");
rmSync(heldNativeDirectory, { recursive: true, force: true });
if (existsSync(nativeDirectory)) renameSync(nativeDirectory, heldNativeDirectory);

try {
  rmSync("dist", { recursive: true, force: true });
  const result = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json"], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  if (existsSync(heldNativeDirectory)) {
    mkdirSync("dist", { recursive: true });
    renameSync(heldNativeDirectory, nativeDirectory);
  }
}
