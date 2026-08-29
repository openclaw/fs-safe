import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePackageDirectory, nativeTargets } from "./native-targets.mjs";

const sourceIndex = process.argv.indexOf("--source");
const destinationIndex = process.argv.indexOf("--destination");
const sourceRoot = resolve(sourceIndex >= 0 ? process.argv[sourceIndex + 1] : "artifacts");
const destinationRoot = destinationIndex >= 0 ? resolve(process.argv[destinationIndex + 1]) : undefined;

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const artifacts = filesBelow(sourceRoot);
for (const target of nativeTargets) {
  const matches = artifacts.filter((path) => basename(path) === target.artifact);
  if (matches.length !== 1) {
    throw new Error(
      `${target.label} requires exactly one ${target.artifact}; found ${matches.length}`,
    );
  }
  const [source] = matches;
  if (statSync(source).size === 0) throw new Error(`${target.artifact} is empty`);
  const packageDirectory = fileURLToPath(nativePackageDirectory(target));
  const destination = destinationRoot
    ? join(destinationRoot, target.label, "fs-safe-native.node")
    : join(packageDirectory, "fs-safe-native.node");
  rmSync(destination, { force: true });
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (statSync(destination).size === 0) throw new Error(`${destination} is empty after copy`);
  console.log(`${target.label}: ${statSync(destination).size} bytes`);
}
