import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostNativeTarget, nativePackageDirectory } from "./native-targets.mjs";

const target = hostNativeTarget();
if (process.platform !== "freebsd" || !target) throw new Error("FreeBSD native build requires a FreeBSD x64 or arm64 host");
const built = spawnSync("cargo", ["build", "--locked", "--release", "-p", "fs-safe-native"], { stdio: "inherit" });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
copyFileSync(resolve("target/release/libfs_safe_native.so"), resolve("native", target.artifact));
await import("./stage-host-native.mjs");
if (process.argv.includes("--link-workspace")) {
  const directory = fileURLToPath(nativePackageDirectory(target));
  const link = resolve("node_modules", ...target.package.split("/"));
  mkdirSync(dirname(link), { recursive: true });
  if (lstatSync(link, { throwIfNoEntry: false })) {
    if (realpathSync(link) !== realpathSync(directory)) throw new Error("native workspace link already points elsewhere");
  } else {
    symlinkSync(relative(dirname(link), directory), link, "dir");
  }
}
