import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { hostNativeTarget } from "./native-targets.mjs";

const target = hostNativeTarget();
if (process.platform !== "freebsd" || !target) throw new Error("FreeBSD native build requires a FreeBSD x64 or arm64 host");
const built = spawnSync("cargo", ["build", "--locked", "--release", "-p", "fs-safe-native"], { stdio: "inherit" });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
copyFileSync(resolve("target/release/libfs_safe_native.so"), resolve("native", target.artifact));
await import("./stage-host-native.mjs");
