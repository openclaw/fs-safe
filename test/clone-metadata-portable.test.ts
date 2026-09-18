import { execFileSync } from "node:child_process";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { readCloneFileMetadata, type CloneFileMetadata } from "../src/copy.js";
import {
  configureFsSafeNative,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
if (process.platform === "darwin") {
  try {
    native = __loadBundledNativeForTest();
  } catch (error) {
    if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
  }
}

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function portable(mode: "auto" | "off") {
  const loader = vi.fn(() => { throw new Error("optional package omitted"); });
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode });
  return loader;
}

async function portableSnapshot(paths: readonly string[], mode: "auto" | "off") {
  let expected: (CloneFileMetadata | undefined)[] | undefined;
  if (native) {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    expected = await readCloneFileMetadata(paths);
  }
  const loader = portable(mode);
  const result = await readCloneFileMetadata(paths);
  expect(result).toHaveLength(paths.length);
  if (expected) expect(result).toEqual(expected);
  if (mode === "off") expect(loader).not.toHaveBeenCalled();
  else expect(loader).toHaveBeenCalledOnce();
  return result;
}

function expectExactSnapshot(metadata: CloneFileMetadata | undefined, stat: BigIntStats) {
  assert(metadata);
  expect(typeof metadata.ino).toBe("bigint");
  expect(typeof metadata.size).toBe("bigint");
  expect(typeof metadata.cloneId).toBe("bigint");
  expect(metadata.ino).toBe(stat.ino);
  expect(metadata.size).toBe(stat.size);
  expect(BigInt(metadata.dev)).toBe(stat.dev);
  expect(BigInt(metadata.mode)).toBe(stat.mode);
  expect(BigInt(metadata.uid)).toBe(stat.uid);
  expect(BigInt(metadata.gid)).toBe(stat.gid);
  expect(BigInt(metadata.mtimeSec) * 1_000_000_000n + BigInt(metadata.mtimeNs)).toBe(stat.mtimeNs);
  expect(BigInt(metadata.ctimeSec) * 1_000_000_000n + BigInt(metadata.ctimeNs)).toBe(stat.ctimeNs);
}

describe.runIf(process.platform === "darwin")("portable APFS clone metadata", () => {
  describe.each(["off", "auto"] as const)("native mode %s", (mode) => {
    it("reports real clone provenance and preserves exact native snapshots", async () => {
      const directory = await tempRoot("fs-safe-portable-clone-id-");
      const original = path.join(directory, "original");
      const cloned = path.join(directory, "cloned");
      const independent = path.join(directory, "independent");
      const bytes = Buffer.alloc(256 * 1024, 0x5a);
      await fs.writeFile(original, bytes, { mode: 0o640 });
      execFileSync("/bin/cp", ["-c", "-n", original, cloned], { timeout: 10_000, stdio: "pipe" });
      await fs.writeFile(independent, bytes, { mode: 0o600 });
      const paths = [original, cloned, independent];
      const before = await Promise.all(paths.map((file) => fs.lstat(file, { bigint: true })));
      const snapshots = await portableSnapshot(paths, mode);
      for (const [index, snapshot] of snapshots.entries()) expectExactSnapshot(snapshot, before[index]!);
      expect(snapshots[0]!.cloneId).not.toBe(0n);
      expect(snapshots[1]!.cloneId).toBe(snapshots[0]!.cloneId);
      expect(snapshots[2]!.cloneId).not.toBe(snapshots[0]!.cloneId);
      expect(snapshots[1]!.ino).not.toBe(snapshots[0]!.ino);
      expect(await Promise.all(paths.map(async (file) => (await fs.lstat(file, { bigint: true })).mode)))
        .toEqual(before.map((stat) => stat.mode));

      await fs.writeFile(cloned, "independent edit");
      const after = await readCloneFileMetadata([original, cloned]);
      expect(after[0]!.cloneId).not.toBe(after[1]!.cloneId);
      expect(await fs.readFile(original)).toEqual(bytes);
    }, 30_000);

    it("keeps quotes, backslashes, Unicode and control characters as pathname data", async () => {
      const directory = await tempRoot("fs-safe-portable-clone-names-");
      const names = ["quotes'\"$`", "literal\\backslash", "é-😀-日本語", "line\nreturn\rseparator\u2028"];
      const paths = names.map((name) => path.join(directory, name));
      await Promise.all(paths.map((file, index) => fs.writeFile(file, `payload ${index}`, { mode: 0o600 })));
      const before = await Promise.all(paths.map((file) => fs.lstat(file, { bigint: true })));
      const snapshots = await portableSnapshot(paths, mode);
      for (const [index, snapshot] of snapshots.entries()) expectExactSnapshot(snapshot, before[index]!);
      expect((await fs.readdir(directory)).sort()).toEqual([...names].sort());
    }, 30_000);

    it("matches native UTF-8 replacement for lone surrogates while preserving valid pairs", async () => {
      const directory = await tempRoot("fs-safe-portable-clone-surrogates-");
      const names = [
        "suffix-high-\ud800", "suffix-low-\udc00", "embedded-\ud800-middle-\udc00-end",
        "valid-pair-\ud83d\ude00", "quotes'\"$`-\ud800-backslash\\-\udc00",
      ];
      const originalPaths = names.map((name) => path.join(directory, name));
      await Promise.all(originalPaths.map((file, index) => fs.writeFile(file, `surrogate ${index}`, { mode: 0o600 })));
      const paths = originalPaths.flatMap((file) => [file, file.toWellFormed()]);
      const before = await Promise.all(paths.map((file) => fs.lstat(file, { bigint: true })));
      for (let index = 0; index < before.length; index += 2) expect(before[index]!.ino).toBe(before[index + 1]!.ino);
      const snapshots = await portableSnapshot(paths, mode);
      for (const [index, snapshot] of snapshots.entries()) expectExactSnapshot(snapshot, before[index]!);
      for (let index = 0; index < snapshots.length; index += 2) expect(snapshots[index]).toEqual(snapshots[index + 1]);
      expect((await fs.readdir(directory)).sort()).toEqual(names.map((name) => name.toWellFormed()).sort());
      expect(names[3]!.toWellFormed()).toBe("valid-pair-😀");
      expect(await Promise.all(paths.map(async (file) => (await fs.lstat(file, { bigint: true })).mode)))
        .toEqual(before.map((stat) => stat.mode));
    }, 30_000);

    it("preserves the existing public normalization of a symlink followed by parent traversal", async () => {
      const directory = await tempRoot("fs-safe-portable-clone-spelling-");
      await fs.mkdir(path.join(directory, "physical", "nested"), { recursive: true });
      const normalized = path.join(directory, "value");
      const physical = path.join(directory, "physical", "value");
      await fs.writeFile(normalized, "lexical public target");
      await fs.writeFile(physical, "different physical target");
      await fs.symlink(path.join(directory, "physical", "nested"), path.join(directory, "link"));
      // Keep the original spelling here: path.join would erase the distinction.
      const raw = `${directory}/link/../value`;
      const normalizedStat = await fs.lstat(normalized, { bigint: true });
      const physicalStat = await fs.lstat(raw, { bigint: true });
      expect(physicalStat.ino).not.toBe(normalizedStat.ino);
      const [snapshot] = await portableSnapshot([raw], mode);
      expectExactSnapshot(snapshot, normalizedStat);
      expect(snapshot!.ino).not.toBe(physicalStat.ino);
    }, 30_000);

    it("observes mode-zero files and leaf symlinks without reading or following them", async () => {
      const directory = await tempRoot("fs-safe-portable-clone-metadata-");
      const file = path.join(directory, "mode-zero");
      const link = path.join(directory, "leaf-link");
      const dangling = path.join(directory, "dangling");
      const missing = path.join(directory, "missing");
      await fs.writeFile(file, Buffer.alloc(8193, 0x39));
      await fs.chmod(file, 0);
      await fs.symlink(file, link);
      await fs.symlink("missing", dangling);
      const paths = [file, link, dangling];
      const before = await Promise.all(paths.map((entry) => fs.lstat(entry, { bigint: true })));
      expect(before[0]!.mode & 0o7777n).toBe(0n);
      if (process.getuid?.() !== 0) {
        await expect(fs.readFile(file)).rejects.toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) });
      }
      const snapshots = await portableSnapshot([...paths, missing, directory], mode);
      for (const [index, stat] of before.entries()) expectExactSnapshot(snapshots[index], stat);
      expect(snapshots[1]!.ino).not.toBe(snapshots[0]!.ino);
      expect(snapshots[1]!.mode & 0o170000).toBe(0o120000);
      expect(snapshots[2]!.mode & 0o170000).toBe(0o120000);
      expect(snapshots.slice(3)).toEqual([undefined, undefined]);
      expect((await fs.lstat(file, { bigint: true })).mode).toBe(before[0]!.mode);
      expect(await fs.readlink(link)).toBe(file);
      expect(await fs.readlink(dangling)).toBe("missing");
    }, 30_000);

    it("preserves input order, repeated entries and unavailable entries across large batches", async () => {
      const directory = await tempRoot("fs-safe-portable-clone-batch-");
      const files = Array.from({ length: 137 }, (_, index) => path.join(directory, `file-${index}`));
      await Promise.all(files.map((file, index) => fs.writeFile(file, Buffer.alloc(index + 1, index), { mode: 0o600 })));
      const stats = new Map(await Promise.all(files.map(async (file) => [file, await fs.lstat(file, { bigint: true })] as const)));
      const paths = [...files, ...files.toReversed(), files[0]!];
      paths.splice(127, 0, path.join(directory, "missing"), directory);
      const snapshots = await portableSnapshot(paths, mode);
      expect(snapshots).toHaveLength(277);
      for (const [index, file] of paths.entries()) {
        const stat = stats.get(file);
        if (stat) expectExactSnapshot(snapshots[index], stat);
        else expect(snapshots[index]).toBeUndefined();
      }
      expect(snapshots.at(-1)).toEqual(snapshots[0]);
    }, 30_000);
  });

  it("uses JXA when an automatically loaded addon lacks only the metadata method", async () => {
    const directory = await tempRoot("fs-safe-portable-clone-partial-");
    const file = path.join(directory, "file");
    await fs.writeFile(file, "partial addon");
    __setNativeLoaderForTest(() => ({ closeOwnedFd() {} }) as unknown as NativeBinding);
    configureFsSafeNative({ mode: "auto" });
    const [snapshot] = await readCloneFileMetadata([file]);
    expectExactSnapshot(snapshot, await fs.lstat(file, { bigint: true }));
  }, 30_000);
});

describe("clone metadata dispatch", () => {
  it.each(["missing-addon", "missing-method"] as const)("keeps require diagnostic for %s", async (failure) => {
    __setNativeLoaderForTest(() => {
      if (failure === "missing-addon") throw new Error("optional package omitted");
      return { closeOwnedFd() {} } as unknown as NativeBinding;
    });
    configureFsSafeNative({ mode: "require" });
    await expect(readCloneFileMetadata([path.resolve("unused")])).rejects.toMatchObject({ code: "helper-unavailable" });
  });

  it("does not retry an operational native metadata failure through JXA", async () => {
    const failure = Object.assign(new Error("native metadata query failed"), { code: "EIO" });
    const read = vi.fn(async () => { throw failure; });
    __setNativeLoaderForTest(() => ({ closeOwnedFd() {}, readCloneFileMetadata: read }) as unknown as NativeBinding);
    configureFsSafeNative({ mode: "auto" });
    await expect(readCloneFileMetadata([path.resolve("unused")])).rejects.toBe(failure);
    expect(read).toHaveBeenCalledOnce();
  });
});
