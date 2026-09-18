import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeExtractedTreeIntoDestination } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  __resetFsSafeNativeConfigForTest();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

async function fixture() {
  const base = await tempRoot("fs-safe-merge-source-authority-");
  const sourceDir = path.join(base, "source");
  const destinationDir = path.join(base, "destination");
  const ancestor = path.join(sourceDir, "nested");
  const targetParent = path.join(destinationDir, "nested");
  const source = path.join(ancestor, "value");
  const target = path.join(targetParent, "value");
  const replacement = path.join(base, "replacement");
  const displaced = path.join(base, "displaced");
  await fs.mkdir(ancestor, { recursive: true });
  await fs.mkdir(targetParent, { recursive: true });
  await fs.mkdir(replacement);
  await fs.writeFile(source, "ADMITTED");
  await fs.writeFile(target, "OLD");
  await fs.writeFile(path.join(replacement, "value"), "REPLACEMENT");
  return { source, target, ancestor, targetParent, replacement, displaced,
    params: { sourceDir, destinationDir, destinationRealDir: destinationDir } };
}

function observeSource(source: string, afterRead?: () => void) {
  let opened: FileHandle | undefined;
  let opens = 0;
  let closes = 0;
  let bytes = 0;
  let stats = 0;
  const fstat = fsSync.fstatSync.bind(fsSync);
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    if (opened?.fd === args[0]) stats++;
    return fstat(...args);
  });
  return {
    afterOpen(candidate: string, handle: FileHandle) {
      if (candidate !== source) return;
      opened = handle;
      opens++;
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...args) => {
        const result = await read(...args);
        bytes += result.bytesRead;
        if (result.bytesRead > 0) afterRead?.();
        return result;
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { closes++; await close(); });
    },
    result: () => ({ opens, closes, bytes, stats, fd: opened?.fd }),
  };
}

function observeSourceMetadata(sourceDir: string) {
  let calls = 0;
  const observe = (candidate: unknown) => {
    const name = String(candidate);
    if (name === sourceDir || name.startsWith(sourceDir + path.sep)) calls++;
  };
  for (const method of ["lstatSync", "statSync"] as const) {
    const actual = fsSync[method].bind(fsSync);
    vi.spyOn(fsSync, method).mockImplementation((...args) => {
      observe(args[0]);
      return actual(...args);
    });
  }
  for (const method of ["lstat", "stat", "realpath"] as const) {
    const actual = fs[method].bind(fs);
    vi.spyOn(fs, method).mockImplementation((...args: never[]) => {
      observe(args[0]);
      return actual(...args);
    });
  }
  const realpath = realpathSync.native;
  vi.spyOn(realpathSync, "native").mockImplementation((candidate) => {
    observe(candidate);
    return realpath(candidate);
  });
  return { count: () => calls, reset: () => { calls = 0; } };
}

describe("archive merge source authority", () => {
  it("rejects an empty replacement source after enumeration", async () => {
    const value = await fixture();
    const readdir = fs.readdir.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "readdir").mockImplementation((...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === value.params.sourceDir && !swapped) {
        swapped = true;
        fsSync.renameSync(value.params.sourceDir, value.displaced);
        fsSync.mkdirSync(value.params.sourceDir);
      }
      return readdir(...args);
    });
    await expect(mergeExtractedTreeIntoDestination(value.params)).rejects.toBeDefined();
    expect(swapped).toBe(true);
    await expect(fs.readFile(value.target, "utf8")).resolves.toBe("OLD");
    await expect(fs.readFile(path.join(value.displaced, "nested", "value"), "utf8"))
      .resolves.toBe("ADMITTED");
  });

  it("copies an unchanged source with one open, one transfer, and no additional fstat", async () => {
    const value = await fixture();
    const observed = observeSource(value.source);
    __setFsSafeTestHooksForTest({ afterOpen: observed.afterOpen });

    await mergeExtractedTreeIntoDestination(value.params);

    await expect(fs.readFile(value.target, "utf8")).resolves.toBe("ADMITTED");
    await expect(fs.readFile(value.source, "utf8")).resolves.toBe("ADMITTED");
    // Two opening observations and the existing
    // before-copy, before-publication and after-publication descriptor checks.
    expect(observed.result()).toEqual({ opens: 1, closes: 1, bytes: 8, stats: 5, fd: -1 });
  });

  it.each([1, 4, 8])("bounds whole-merge source metadata work at depth %s", async (depth) => {
    const base = await tempRoot("fs-safe-merge-source-budget-");
    const sourceDir = path.join(base, "source");
    const destinationDir = path.join(base, "destination");
    const relativeDir = Array.from({ length: depth }, (_, index) => `level-${index}`).join(path.sep);
    await fs.mkdir(path.join(sourceDir, relativeDir), { recursive: true });
    await fs.mkdir(path.join(destinationDir, relativeDir), { recursive: true });
    const params = { sourceDir, destinationDir, destinationRealDir: destinationDir };
    const observed = observeSourceMetadata(sourceDir);
    await mergeExtractedTreeIntoDestination(params);
    const empty = observed.count();

    await fs.writeFile(path.join(sourceDir, relativeDir, "value"), "ADMITTED");
    observed.reset();
    await mergeExtractedTreeIntoDestination(params);
    const complete = observed.count();
    const diagnostic = JSON.stringify({ depth, empty, complete, perFile: complete - empty });
    // Includes all source-root and descendant lstat/stat/realpath observations
    // across directory preparation, traversal, file copy, and finalization.
    // A chain has depth entries: O(entries * depth), never a cubic rescan.
    expect(complete, diagnostic).toBeLessThanOrEqual(2 * depth * depth + 25 * depth + 30);
    // Existing work is 2d + <=17; the source-authority delta is 2d + 8.
    // The previous Root.open/stat + repeated full-stack draft exceeds this gate.
    expect(complete - empty, diagnostic).toBeLessThanOrEqual(4 * depth + 26);
    await expect(fs.readFile(path.join(destinationDir, relativeDir, "value"), "utf8")).resolves.toBe("ADMITTED");
  });

  it.each(["directory preparation", "file preparation"] as const)(
    "retains the original child-directory receipt across %s",
    async (timing) => {
      const value = await fixture();
      let visits = 0;
      let swapped = false;
      __setFsSafeTestHooksForTest({
        beforeArchiveOutputMutation(operation, candidate) {
          if (operation !== "mkdir" || candidate !== value.targetParent) return;
          if (++visits !== (timing === "directory preparation" ? 1 : 2)) return;
          fsSync.renameSync(value.ancestor, value.displaced);
          fsSync.renameSync(value.replacement, value.ancestor);
          swapped = true;
        },
      });

      await expect(mergeExtractedTreeIntoDestination(value.params)).rejects.toMatchObject({
        code: "destination-symlink-traversal",
      });
      expect(swapped).toBe(true);
      await expect(fs.readFile(value.target, "utf8")).resolves.toBe("OLD");
      await expect(fs.readFile(value.source, "utf8")).resolves.toBe("REPLACEMENT");
      await expect(fs.readFile(path.join(value.displaced, "value"), "utf8")).resolves.toBe("ADMITTED");
      await expect(fs.readdir(value.targetParent)).resolves.toEqual(["value"]);
    },
  );

  itPosix("rejects an ancestor alias introduced during guarded source admission", async () => {
    const value = await fixture();
    let swapped = false;
    __setFsSafeTestHooksForTest({
      afterPreOpenLstat(candidate) {
        if (candidate !== value.source || swapped) return;
        fsSync.renameSync(value.ancestor, value.displaced);
        fsSync.symlinkSync(value.replacement, value.ancestor, "dir");
        swapped = true;
      },
    });

    await expect(mergeExtractedTreeIntoDestination(value.params)).rejects.toBeDefined();
    expect(swapped).toBe(true);
    await expect(fs.readFile(value.target, "utf8")).resolves.toBe("OLD");
    await expect(fs.readFile(value.source, "utf8")).resolves.toBe("REPLACEMENT");
    await expect(fs.readdir(value.targetParent)).resolves.toEqual(["value"]);
  });

  it.each([false, true])("rejects a leaf replaced after metadata admission (rounded Windows identity: %s)", async (rounded) => {
    const value = await fixture();
    const actualFstat = fsSync.fstatSync.bind(fsSync);
    const observed = observeSource(value.source);
    const originalIno = 9007199254740992n;
    let swapped = false;
    let sourceFd: number | undefined;
    if (rounded) {
      // Exact identity adapter over real I/O, not a claim about Windows kernel races.
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(Number(originalIno)).toBe(Number(originalIno + 1n));
      for (const method of ["lstatSync", "statSync"] as const) {
        const actual = fsSync[method].bind(fsSync);
        vi.spyOn(fsSync, method).mockImplementation((...args) => {
          const stat = actual(...args);
          if (String(args[0]) === value.source) {
            const ino = originalIno + (swapped ? 1n : 0n);
            stat.ino = args[1]?.bigint ? ino : Number(ino);
          }
          return stat;
        });
      }
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
        const stat = actualFstat(...args);
        if (args[0] === sourceFd) stat.ino = args[1]?.bigint ? originalIno + 1n : Number(originalIno + 1n);
        return stat;
      });
    }
    let visits = 0;
    __setFsSafeTestHooksForTest({
      beforeArchiveOutputMutation(operation, candidate) {
        if (operation !== "mkdir" || candidate !== value.targetParent || ++visits !== 2) return;
        fsSync.renameSync(value.source, value.displaced);
        fsSync.renameSync(path.join(value.replacement, "value"), value.source);
        swapped = true;
      },
      afterOpen(candidate, handle) {
        if (candidate === value.source) sourceFd = handle.fd;
        observed.afterOpen(candidate, handle);
      },
    });

    await expect(mergeExtractedTreeIntoDestination(value.params)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    expect(observed.result()).toMatchObject({ opens: 1, closes: 1, bytes: 0, fd: -1 });
    await expect(fs.readFile(value.target, "utf8")).resolves.toBe("OLD");
    await expect(fs.readFile(value.source, "utf8")).resolves.toBe("REPLACEMENT");
    await expect(fs.readdir(value.targetParent)).resolves.toEqual(["value"]);
  });

  it("rejects rounded-equal Windows child-directory replacements", async () => {
    const value = await fixture();
    const originalIno = 9007199254740992n;
    let swapped = false;
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (String(args[0]) === value.ancestor) {
        const ino = originalIno + (swapped ? 1n : 0n);
        stat.ino = args[1]?.bigint ? ino : Number(ino);
      }
      return stat;
    });
    __setFsSafeTestHooksForTest({
      beforeArchiveOutputMutation(operation, candidate) {
        if (operation !== "mkdir" || candidate !== value.targetParent || swapped) return;
        fsSync.renameSync(value.ancestor, value.displaced);
        fsSync.renameSync(value.replacement, value.ancestor);
        swapped = true;
      },
    });

    await expect(mergeExtractedTreeIntoDestination(value.params)).rejects.toMatchObject({
      code: "destination-symlink-traversal",
    });
    expect(swapped).toBe(true);
    await expect(fs.readFile(value.target, "utf8")).resolves.toBe("OLD");
  });

  itPosix("rechecks active source ancestors before publication even when the leaf identity is unchanged", async () => {
    const value = await fixture();
    let swapped = false;
    const observed = observeSource(value.source, () => {
      if (swapped) return;
      fsSync.renameSync(value.ancestor, value.displaced);
      fsSync.renameSync(value.replacement, value.ancestor);
      fsSync.renameSync(value.source, path.join(value.displaced, "replacement-value"));
      fsSync.renameSync(path.join(value.displaced, "value"), value.source);
      swapped = true;
    });
    __setFsSafeTestHooksForTest({ afterOpen: observed.afterOpen });

    await expect(mergeExtractedTreeIntoDestination(value.params)).rejects.toMatchObject({
      code: "destination-symlink-traversal",
    });
    expect(swapped).toBe(true);
    expect(observed.result()).toMatchObject({ opens: 1, closes: 1, bytes: 8, fd: -1 });
    await expect(fs.readFile(value.target, "utf8")).resolves.toBe("OLD");
    await expect(fs.readFile(value.source, "utf8")).resolves.toBe("ADMITTED");
    await expect(fs.readdir(value.targetParent)).resolves.toEqual(["value"]);
  });

  itPosix("checks ancestors above an unchanged admitted source-directory frontier", async () => {
    const value = await fixture();
    const sourceParent = path.join(value.ancestor, "inner");
    const targetParent = path.join(value.targetParent, "inner");
    const source = path.join(sourceParent, "value");
    const target = path.join(targetParent, "value");
    await fs.mkdir(sourceParent);
    await fs.mkdir(targetParent);
    await fs.rename(value.source, source);
    await fs.rename(value.target, target);
    let swapped = false;
    const observed = observeSource(source, () => {
      if (swapped) return;
      fsSync.renameSync(value.ancestor, value.displaced);
      fsSync.renameSync(value.replacement, value.ancestor);
      fsSync.renameSync(path.join(value.displaced, "inner"), sourceParent);
      swapped = true;
    });
    __setFsSafeTestHooksForTest({ afterOpen: observed.afterOpen });

    await expect(mergeExtractedTreeIntoDestination(value.params)).rejects.toMatchObject({
      code: "destination-symlink-traversal",
    });
    expect(swapped).toBe(true);
    expect(observed.result()).toMatchObject({ opens: 1, closes: 1, bytes: 8, fd: -1 });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("OLD");
    await expect(fs.readFile(source, "utf8")).resolves.toBe("ADMITTED");
    await expect(fs.readdir(targetParent)).resolves.toEqual(["value"]);
  });

  it("preserves completed publication when a source directory changes before mode finalization", async () => {
    const value = await fixture();
    let swapped = false;
    __setFsSafeTestHooksForTest({
      beforeArchiveOutputMutation(operation, candidate) {
        if (operation !== "chmod" || candidate !== value.targetParent) return;
        fsSync.renameSync(value.ancestor, value.displaced);
        fsSync.renameSync(value.replacement, value.ancestor);
        swapped = true;
      },
    });

    await expect(mergeExtractedTreeIntoDestination(value.params)).rejects.toMatchObject({
      code: "destination-symlink-traversal",
    });
    expect(swapped).toBe(true);
    await expect(fs.readFile(value.target, "utf8")).resolves.toBe("ADMITTED");
    await expect(fs.readFile(value.source, "utf8")).resolves.toBe("REPLACEMENT");
    await expect(fs.readdir(value.targetParent)).resolves.toEqual(["value"]);
  });

  itPosix("takes ordinary permission bits from the admitted descriptor", async () => {
    const value = await fixture();
    await fs.chmod(value.source, 0o7640);
    let visits = 0;
    __setFsSafeTestHooksForTest({
      beforeArchiveOutputMutation(operation, candidate) {
        if (operation === "mkdir" && candidate === value.targetParent && ++visits === 2) {
          fsSync.chmodSync(value.source, 0o7604);
        }
      },
    });

    await mergeExtractedTreeIntoDestination(value.params);

    expect(visits).toBe(2);
    expect((await fs.stat(value.target)).mode & 0o7777).toBe(0o604);
    expect((await fs.stat(value.source)).mode & 0o777).toBe(0o604);
    await expect(fs.readFile(value.target, "utf8")).resolves.toBe("ADMITTED");
  });
});
