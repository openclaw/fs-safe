import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { checkLinuxGlibc, linuxGlibcFloor } from "./check-linux-glibc.mjs";
import { nativeTargets } from "./native-targets.mjs";

const target = nativeTargets.find((entry) => entry.rust === process.argv[2] && entry.libc === "glibc");
if (!target || process.argv.length !== 3) {
  throw new Error("usage: node scripts/build-linux-gnu.mjs <x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu>");
}
const repository = resolve(import.meta.dirname, "..");
const targetDirectory = resolve(repository, "target");
execFileSync("cargo", [
  "zigbuild", "--manifest-path", "native/Cargo.toml", "--release", "--locked",
  "--target", `${target.rust}.${linuxGlibcFloor}`, "--target-dir", targetDirectory,
], { cwd: repository, stdio: "inherit" });

// N-API is exported by the cdylib; the platform package loads this file directly.
const artifactDirectory = resolve(repository, "artifacts");
mkdirSync(artifactDirectory, { recursive: true });
const artifact = resolve(artifactDirectory, target.artifact);
copyFileSync(resolve(targetDirectory, target.rust, "release/libfs_safe_native.so"), artifact);
checkLinuxGlibc(artifact);
