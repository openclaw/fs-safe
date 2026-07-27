import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hostNativeTarget } from "./native-targets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const target = hostNativeTarget();
if (!target) throw new Error(`no bundled native target for ${process.platform}-${process.arch}`);

const source = resolve(repositoryRoot, "native", target.artifact);
const destination = resolve(
  repositoryRoot,
  "dist",
  "native",
  target.label,
  "fs-safe-native.node",
);
if (statSync(source).size === 0) throw new Error(`${target.artifact} is empty`);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`staged ${target.label} binding at dist/native/${target.label}/fs-safe-native.node`);
