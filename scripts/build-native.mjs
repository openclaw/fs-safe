import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hostNativeTarget, nativeTargets } from "./native-targets.mjs";
import { verifyWindowsRuntime, windowsRuntimeEnv } from "./windows-runtime.mjs";

const args = process.argv.slice(2);
const { values } = parseArgs({ args, options: {
  release: { type: "boolean" },
  target: { type: "string" },
  "output-dir": { type: "string" },
} });
const target = values.target ? nativeTargets.find(entry => entry.rust === values.target) : hostNativeTarget();
if (!target) throw new Error(`unsupported native build target: ${values.target ?? `${process.platform}-${process.arch}`}`);
const root = fileURLToPath(new URL("../", import.meta.url));
const native = resolve(root, "native");
if (target.os === "win32" && values.release) {
  execFileSync("cargo", ["build", "--locked", "-p", "fs-safe-native", "--target", target.rust,
    ...(values.release ? ["--release"] : [])], { cwd: root, stdio: "inherit", env: windowsRuntimeEnv(process.env) });
  const source = resolve(root, process.env.CARGO_TARGET_DIR ?? "target", target.rust,
    values.release ? "release" : "debug", "fs_safe_native.dll");
  verifyWindowsRuntime(readFileSync(source), target.cpu);
  const destination = resolve(native, values["output-dir"] ?? ".", target.artifact);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
} else {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("@napi-rs/cli/package.json");
  const cli = resolve(dirname(manifest), require(manifest).bin.napi);
  execFileSync(process.execPath, [cli, "build", "--platform", ...args], { cwd: native, stdio: "inherit" });
}
