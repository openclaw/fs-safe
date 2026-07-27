import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { publishFileExclusive } from "../dist/publish-file.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../dist/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../dist/native.js";

const native = __loadBundledNativeForTest();
const sizes = [
  { label: "4 KiB", bytes: 4 * 1024, iterations: 7 },
  { label: "1 MiB", bytes: 1024 * 1024, iterations: 7 },
  { label: "64 MiB", bytes: 64 * 1024 * 1024, iterations: 5 },
];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-bench-publish-"));
const filesystem = await fs.statfs(root);
const filesystemName =
  process.platform === "darwin" && filesystem.type === 26
    ? "APFS"
    : `type-${Number(filesystem.type).toString(16)}`;
const originalLink = fs.link;
const rows = [];

try {
  for (const fixture of sizes) {
    const sourcePath = path.join(root, `source-${fixture.bytes}`);
    const source = await fs.open(sourcePath, "w", 0o600);
    try {
      const chunk = Buffer.alloc(Math.min(fixture.bytes, 1024 * 1024), 0x5a);
      for (let position = 0; position < fixture.bytes; ) {
        const length = Math.min(chunk.length, fixture.bytes - position);
        const { bytesWritten } = await source.write(chunk, 0, length, position);
        if (bytesWritten <= 0) throw new Error("benchmark fixture write made no progress");
        position += bytesWritten;
      }
      await source.sync();
    } finally {
      await source.close();
    }

    for (const mode of ["javascript", "native"]) {
      let selectedTier = mode === "javascript" ? "js-loop" : undefined;
      __resetFsSafeNativeConfigForTest();
      __resetNativeLoaderForTest();
      if (mode === "javascript") {
        configureFsSafeNative({ mode: "off" });
        fs.link = async () => {
          throw Object.assign(new Error("benchmark forces copy fallback"), { code: "EXDEV" });
        };
      } else {
        fs.link = originalLink;
        __setNativeLoaderForTest(() => ({
          ...native,
          linkBeneath() {
            throw Object.assign(new Error("benchmark forces copy fallback"), { code: "EXDEV" });
          },
          cloneFileExclusive(...args) {
            const fd = native.cloneFileExclusive(...args);
            selectedTier = "clone";
            return fd;
          },
          async copyFileRangeExclusive(...args) {
            const result = await native.copyFileRangeExclusive(...args);
            if (!result.errorCode) selectedTier = "copy_file_range";
            return result;
          },
        }));
        configureFsSafeNative({ mode: "require" });
      }

      const samples = [];
      const tiers = new Set();
      for (let iteration = 0; iteration < fixture.iterations; iteration += 1) {
        selectedTier = mode === "javascript" ? "js-loop" : undefined;
        const targetPath = path.join(root, `target-${mode}-${fixture.bytes}-${iteration}`);
        const started = performance.now();
        const result = await publishFileExclusive({
          sourcePath,
          targetPath,
          strategy: "link-or-copy",
        });
        samples.push(performance.now() - started);
        if (result.method !== "exclusive-copy") {
          throw new Error(`unexpected publication method: ${result.method}`);
        }
        tiers.add(selectedTier ?? "js-loop");
        const stat = await fs.stat(targetPath);
        if (stat.size !== fixture.bytes) throw new Error("benchmark publication size mismatch");
        await fs.rm(targetPath);
      }
      samples.sort((a, b) => a - b);
      const medianMs = samples[Math.floor(samples.length / 2)];
      rows.push({
        size: fixture.label,
        mode,
        tier: [...tiers].join(" -> "),
        medianMs: Number(medianMs.toFixed(2)),
        throughputMiBs: Number(
          ((fixture.bytes / (1024 * 1024)) / (medianMs / 1000)).toFixed(1),
        ),
      });
    }

    if (process.platform === "darwin") {
      const source = await fs.open(sourcePath, "r");
      const directory = await fs.open(root, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
      const samples = [];
      try {
        for (let iteration = 0; iteration < fixture.iterations; iteration += 1) {
          const targetName = `target-clone-primitive-${fixture.bytes}-${iteration}`;
          const started = performance.now();
          const fd = native.cloneFileExclusive(source.fd, directory.fd, targetName);
          samples.push(performance.now() - started);
          fsSync.closeSync(fd);
          await fs.rm(path.join(root, targetName));
        }
      } finally {
        await directory.close();
        await source.close();
      }
      samples.sort((a, b) => a - b);
      const medianMs = samples[Math.floor(samples.length / 2)];
      rows.push({
        size: fixture.label,
        mode: "native primitive",
        tier: "clone",
        medianMs: Number(medianMs.toFixed(2)),
        throughputMiBs: null,
      });
    }
  }
} finally {
  fs.link = originalLink;
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  await fs.rm(root, { recursive: true, force: true });
}

console.log(
  `publish benchmark (${process.platform}-${process.arch}, Node ${process.version}, ${filesystemName}, ${os.tmpdir()})`,
);
console.log("| Size | Path | Exercised tier | Median ms | MiB/s |");
console.log("|---:|:---|:---|---:|---:|");
for (const row of rows) {
  const throughput = row.throughputMiBs === null ? "n/a" : row.throughputMiBs.toFixed(1);
  console.log(`| ${row.size} | ${row.mode} | ${row.tier} | ${row.medianMs.toFixed(2)} | ${throughput} |`);
}
console.log(
  JSON.stringify({
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    filesystem: filesystemName,
    tempRoot: os.tmpdir(),
    rows,
  }),
);
