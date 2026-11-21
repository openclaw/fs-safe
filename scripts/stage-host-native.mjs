import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostNativeTarget, nativePackageDirectory } from "./native-targets.mjs";
import { verifyWindowsRuntime } from "./windows-runtime.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const target = hostNativeTarget();
if (!target) throw new Error(`no native target for ${process.platform}-${process.arch}`);

const source = resolve(repositoryRoot, "native", target.artifact);
const destination = resolve(fileURLToPath(nativePackageDirectory(target)), "fs-safe-native.node");
if (statSync(source).size === 0) throw new Error(`${target.artifact} is empty`);
if (target.os === "win32" && !process.argv.includes("--development")) verifyWindowsRuntime(readFileSync(source), target.cpu);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`staged ${target.label} binding at packages/${target.label}/fs-safe-native.node`);
