import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { downloadArchive } from "./download.mjs";

// Use the official WASI SDK 34 LLVM tools. Verify before extracting because
// upstream release assets can be replaced without changing their names.
const assets = {
  "linux-x64": ["x86_64-linux", "b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4"],
  "darwin-arm64": ["arm64-macos", "9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9"],
  "darwin-x64": ["x86_64-macos", "87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb"],
  "win32-x64": ["x86_64-windows", "cccb5c323a9b34f0349a9b09e8804a0a7632c68c3310f4b5f437ed57d7e71d8f"],
};
const asset = assets[`${process.platform}-${process.arch}`];
if (!asset) throw new Error(`Unsupported archive compiler host: ${process.platform}-${process.arch}`);
if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) {
  throw new Error("Archive compiler setup requires RUNNER_TEMP and GITHUB_ENV.");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

const [platform, expectedHash] = asset;
const directory = await mkdtemp(join(process.env.RUNNER_TEMP, "fs-safe-archive-llvm-"));
const sdkName = `wasi-sdk-34.0-${platform}`;
const archive = join(directory, `${sdkName}.tar.gz`);
try {
  await downloadArchive(
    `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/${sdkName}.tar.gz`,
    archive,
    expectedHash,
    sdkName,
  );
  const tar = process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  run(tar, ["-xzf", archive, "-C", directory]);
  await rm(archive);

  const suffix = process.platform === "win32" ? ".exe" : "";
  const clang = join(directory, sdkName, "bin", `clang${suffix}`);
  const archiver = join(directory, sdkName, "bin", `llvm-ar${suffix}`);
  run(clang, ["--version"]);
  run(archiver, ["--version"]);
  const source = join(directory, "probe.c");
  const object = join(directory, "probe.o");
  await writeFile(source, "int archive_llvm_probe(void) { return 0; }\n");
  // Disable WASI defaults: these tools produce objects for Rust's freestanding
  // target and do not supply its linker or any host-native compiler defaults.
  run(clang, ["--no-default-config", "--target=wasm32-unknown-unknown", "-ffreestanding", "-c", source, "-o", object]);
  run(archiver, ["crs", join(directory, "probe.a"), object]);
  await appendFile(process.env.GITHUB_ENV, `CC_wasm32_unknown_unknown=${clang}\nAR_wasm32_unknown_unknown=${archiver}\n`);
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
