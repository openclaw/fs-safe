import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Official WASI SDK 27 contains LLVM 20.1.8. Verify before extracting because
// upstream release assets can be replaced without changing their names.
const assets = {
  "linux-x64": ["x86_64-linux", "b7d4d944c88503e4f21d84af07ac293e3440b1b6210bfd7fe78e0afd92c23bc2"],
  "darwin-arm64": ["arm64-macos", "055c3dc2766772c38e71a05d353e35c322c7b2c6458a36a26a836f9808a550f8"],
  "darwin-x64": ["x86_64-macos", "163dfd47f989b1a682744c1ae1f0e09a83ff5c4bbac9dcd8546909ab54cda5a1"],
  "win32-x64": ["x86_64-windows", "4a576c13125c91996d8cc3b70b7ea0612c2044598d2795c9be100d15f874adf6"],
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
const sdkName = `wasi-sdk-27.0-${platform}`;
const archive = join(directory, `${sdkName}.tar.gz`);
try {
  const response = await fetch(
    `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-27/${sdkName}.tar.gz`,
    { signal: AbortSignal.timeout(180_000) },
  );
  if (!response.ok || !response.body) throw new Error(`LLVM download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  await pipeline(response.body, new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }), createWriteStream(archive, { flags: "wx" }));
  if (hash.digest("hex") !== expectedHash) throw new Error(`LLVM checksum mismatch: ${sdkName}`);
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
