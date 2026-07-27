import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const loaderPath = fileURLToPath(new URL("../native/index.js", import.meta.url));
const typesPath = fileURLToPath(new URL("../native/index.d.ts", import.meta.url));
const templatePath = fileURLToPath(new URL("./native-loader.cjs", import.meta.url));
const loader = readFileSync(loaderPath, "utf8");
const hardened = readFileSync(templatePath, "utf8");

if (hardened !== loader) {
  writeFileSync(loaderPath, hardened);
  console.log(`hardened ${loaderPath.slice(root.length)}`);
}

const generatedTypes = readFileSync(typesPath, "utf8");
const hardenedTypes = generatedTypes
  .replace(
    /inspectArchiveNative\(([^)]*)\): Promise<unknown>/,
    "inspectArchiveNative($1): Promise<Array<NativeArchiveEntry>>",
  )
  .replace(
    /extractArchiveNative\(([^)]*)\): Promise<unknown>/,
    "extractArchiveNative($1): Promise<void>",
  )
  .replace(
    /readArchiveEntryNative\(([^)]*)\): Promise<unknown>/,
    "readArchiveEntryNative($1): Promise<Buffer>",
  )
  .replace(
    /sha256File\(([^)]*)\): Promise<unknown>/,
    "sha256File($1): Promise<FileHash>",
  )
  .replace(
    /copyFileRangeExclusive\(([^)]*)\): Promise<unknown>/,
    "copyFileRangeExclusive($1): Promise<NativeCopyResult>",
  )
  .replace(
    /containment: string/,
    "containment: 'kernel-atomic' | 'best-effort'",
  );
if (hardenedTypes !== generatedTypes) {
  writeFileSync(typesPath, hardenedTypes);
  console.log(`hardened ${typesPath.slice(root.length)}`);
}
