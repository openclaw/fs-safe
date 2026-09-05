import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const result = spawnSync("cargo", ["rustc", "--locked", "--release", "-p", "fs-safe-archive-wasm",
  "--target", "wasm32-unknown-unknown", "--", "-C", "link-arg=--max-memory=268435456"], {
  stdio: "inherit", env: process.env,
});
if (result.status !== 0) throw new Error("TAR WASM build failed; install Rust and the wasm32-unknown-unknown target");
const artifact = resolve(process.env.CARGO_TARGET_DIR ?? "target", "wasm32-unknown-unknown/release/fs_safe_archive_wasm.wasm");
const module = new WebAssembly.Module(readFileSync(artifact));
if (WebAssembly.Module.imports(module).length !== 0) throw new Error("TAR WASM must have no host imports");
mkdirSync("dist", { recursive: true });
copyFileSync(artifact, "dist/archive-parser.wasm");
