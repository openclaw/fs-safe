import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  allocatorTestArtifact, archiveWasmBuildEnvironment, validateArchiveWasm,
  WASM_MAX_MEMORY, WASM_TARGET,
} from "./archive-wasm-build-tools.mjs";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--allocator-tests") || args.length > 1) {
  throw new Error("Usage: pnpm archive:wasm [--allocator-tests]");
}
const allocatorTests = args.includes("--allocator-tests");
const env = archiveWasmBuildEnvironment();
const output = allocatorTests ? allocatorTestArtifact() : resolve("dist/archive-parser.wasm");
if (allocatorTests) env.CARGO_TARGET_DIR = dirname(output);
const result = spawnSync("cargo", ["rustc", "--locked", "--release", "-p", "fs-safe-archive-wasm",
  "--target", WASM_TARGET, ...(allocatorTests ? ["--features", "allocator-tests"] : []),
  "--", "-C", "lto=off", "-C", "link-arg=--strip-debug", "-C", `link-arg=--max-memory=${WASM_MAX_MEMORY}`], {
  stdio: "inherit", env,
});
if (result.error) throw new Error("Could not run Cargo for the TAR WASM build; install Rust and its wasm32-unknown-unknown target", { cause: result.error });
if (result.status !== 0) throw new Error(`TAR WASM build failed (${result.signal ?? result.status}); see the Cargo diagnostic above and docs/contributing.md#build`);
const artifact = resolve(env.CARGO_TARGET_DIR ?? "target", `${WASM_TARGET}/release/fs_safe_archive_wasm.wasm`);
validateArchiveWasm(readFileSync(artifact), { allocatorTests });
mkdirSync(dirname(output), { recursive: true });
copyFileSync(artifact, output);
