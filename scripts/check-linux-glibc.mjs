import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const linuxGlibcFloor = "2.28";

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function checkGlibcSymbols(symbolTable) {
  const symbols = [...new Set(symbolTable.match(/\bGLIBC_[A-Za-z0-9_.]+/g) ?? [])];
  if (symbols.length === 0) throw new Error("no GLIBC symbol versions found");
  for (const symbol of symbols) {
    if (!/^GLIBC_\d+(?:\.\d+)+$/.test(symbol)) {
      throw new Error(`unsupported glibc requirement: ${symbol}`);
    }
  }
  const versions = symbols.map((symbol) => symbol.slice("GLIBC_".length));
  const maximum = versions.sort(compareVersions).at(-1);
  if (compareVersions(maximum, linuxGlibcFloor) > 0) {
    throw new Error(`requires GLIBC_${maximum}, exceeds GLIBC_${linuxGlibcFloor}`);
  }
  return maximum;
}

export function checkLinuxGlibc(binary) {
  const maximum = checkGlibcSymbols(execFileSync("objdump", ["-T", binary], { encoding: "utf8" }));
  console.log(`${binary}: maximum GLIBC_${maximum} <= GLIBC_${linuxGlibcFloor}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const binaries = process.argv.slice(2);
  if (!binaries.length) throw new Error("usage: node scripts/check-linux-glibc.mjs <binding.node>...");
  for (const binary of binaries) checkLinuxGlibc(binary);
}
