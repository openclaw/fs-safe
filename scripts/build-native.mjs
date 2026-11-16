import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hostNativeTarget, nativeTargets } from "./native-targets.mjs";
import { verifyWindowsRuntime, windowsRuntimeEnv } from "./windows-runtime.mjs";

export function nativeBuildOutput(output, manifest) {
  const records = output.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
  const artifacts = records.filter(record => record?.reason === "compiler-artifact" &&
    record.manifest_path === manifest && record.target?.crate_types?.includes("cdylib"))
    .flatMap(record => record.filenames).filter(file => file.endsWith(".dll"));
  if (artifacts.length !== 1 || !isAbsolute(artifacts[0])) {
    throw new Error("Cargo must report exactly one native DLL artifact for fs-safe-native");
  }
  return { artifact: artifacts[0], diagnostics: records.filter(record => record?.reason === "compiler-message")
    .map(record => record.message?.rendered).filter(message => typeof message === "string") };
}

function main() {
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
    const output = execFileSync("cargo", ["build", "--locked", "-p", "fs-safe-native", "--target", target.rust,
      "--release", "--message-format=json-render-diagnostics"], {
      cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: windowsRuntimeEnv(process.env),
    });
    const { artifact, diagnostics } = nativeBuildOutput(output, resolve(native, "Cargo.toml"));
    for (const diagnostic of diagnostics) process.stderr.write(diagnostic);
    verifyWindowsRuntime(readFileSync(artifact), target.cpu);
    const destination = resolve(native, values["output-dir"] ?? ".", target.artifact);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(artifact, destination);
  } else {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@napi-rs/cli/package.json");
    const cli = resolve(dirname(manifest), require(manifest).bin.napi);
    execFileSync(process.execPath, [cli, "build", "--platform", ...args], { cwd: native, stdio: "inherit" });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
