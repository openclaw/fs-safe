import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeExtractedTreeIntoDestination } from "../src/archive.js";
import { withExtractionDeadline } from "../src/archive-deadline.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { removeModeFixture } from "./helpers/archive-modes.js";
import { useSuiteFixture } from "./helpers/suite-fixture.js";

let suiteDir: string | undefined;
const runFixture = useSuiteFixture(async () => {
  suiteDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-dir-publication-"));
  return await fs.realpath(suiteDir);
}, async () => {
  if (suiteDir) await removeModeFixture(suiteDir);
});

function run(operation: (directory: string) => Promise<void>) {
  return runFixture(async (directory) => {
    try { await operation(directory); }
    finally {
      // A Vitest timeout must not reset hooks while publication is still running.
      __setFsSafeTestHooksForTest(undefined);
      __resetFsSafeNativeConfigForTest();
      vi.restoreAllMocks();
    }
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(directory: string, children = true) {
  configureFsSafeNative({ mode: "off" });
  const base = await fs.mkdtemp(path.join(directory, "case-"));
  const sourceDir = path.join(base, "source");
  const destinationDir = path.join(base, "destination");
  const sourceNested = path.join(sourceDir, "nested");
  const target = path.join(destinationDir, "nested");
  await fs.mkdir(sourceNested, { recursive: true });
  await fs.chmod(sourceNested, 0o555);
  if (children) {
    await fs.chmod(sourceNested, 0o700);
    await fs.writeFile(path.join(sourceNested, "value"), "NEW");
    await fs.chmod(sourceNested, 0o555);
  }
  await fs.mkdir(destinationDir);
  return { base, sourceNested, target, params: { sourceDir, destinationDir, destinationRealDir: destinationDir } };
}

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("real non-root directory publication", () => {
  it("retains only depth-proportional directory descriptors across many siblings", () => run(async (directory) => {
    const { params } = await fixture(directory, false);
    await fs.rmdir(path.join(params.sourceDir, "nested"));
    for (let sibling = 0; sibling < 20; sibling++) {
      await fs.mkdir(path.join(params.sourceDir, `sibling-${sibling}`, "middle", "leaf"), { recursive: true });
    }
    const realOpen = fs.open.bind(fs);
    let active = 0;
    let peak = 0;
    let closes = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).startsWith(params.destinationDir + path.sep)) {
        active++;
        peak = Math.max(peak, active);
        const close = handle.close.bind(handle);
        handle.close = async () => { active--; closes++; await close(); };
      }
      return handle;
    });
    await mergeExtractedTreeIntoDestination(params);
    expect({ active, peak, closes }).toEqual({ active: 0, peak: 3, closes: 60 });
  }));

  it.each([0o300, 0o700])("updates an existing %s directory after publishing children", (mode) => run(async (directory) => {
    const { target, params } = await fixture(directory);
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, "value"), "OLD");
    await fs.chmod(target, mode);
    await mergeExtractedTreeIntoDestination(params);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o555);
    expect(await fs.readFile(path.join(target, "value"), "utf8")).toBe("NEW");
  }));

  it("finalizes an existing empty search-only directory", () => run(async (directory) => {
    const { target, params } = await fixture(directory, false);
    await fs.mkdir(target, { mode: 0o100 });
    await mergeExtractedTreeIntoDestination(params);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o555);
  }));

  it.each([0o500, 0])("does not widen an existing inaccessible %s directory to write children", (mode) => run(async (directory) => {
    const { target, params } = await fixture(directory);
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, "value"), "OLD");
    await fs.chmod(target, mode);
    await expect(mergeExtractedTreeIntoDestination(params)).rejects.toBeDefined();
    expect((await fs.stat(target)).mode & 0o777).toBe(mode);
    await fs.chmod(target, 0o700);
    expect(await fs.readFile(path.join(target, "value"), "utf8")).toBe("OLD");
  }));

  it.each(["directory", "root", "ancestor"] as const)("rejects a %s substitution before finalization without chmodding it", (swap) => run(async (directory) => {
    const { base, sourceNested, target, params } = await fixture(directory);
    if (swap === "ancestor") {
      await fs.chmod(sourceNested, 0o700);
      await fs.mkdir(path.join(sourceNested, "child"), { mode: 0o555 });
      await fs.chmod(sourceNested, 0o555);
    }
    const moved = path.join(base, "moved");
    const replaced = swap === "root" ? params.destinationDir : target;
    const finalizing = swap === "ancestor" ? path.join(target, "child") : target;
    let original: BigIntStats | undefined;
    __setFsSafeTestHooksForTest({ async beforeArchiveOutputMutation(operation, candidate) {
      if (operation !== "chmod" || candidate !== finalizing) return;
      original = await fs.stat(replaced, { bigint: true });
      await fs.rename(replaced, moved);
      await fs.mkdir(replaced, { mode: 0o750 });
      await fs.chmod(replaced, 0o750);
    } });
    await expect(mergeExtractedTreeIntoDestination(params)).rejects.toMatchObject({ code: "destination-symlink-traversal" });
    expect(original).toBeDefined();
    expect((await fs.stat(replaced)).mode & 0o777).toBe(0o750);
    const retained = await fs.stat(moved, { bigint: true });
    expect({ dev: retained.dev, ino: retained.ino, mode: retained.mode }).toEqual({
      dev: original!.dev, ino: original!.ino, mode: original!.mode,
    });
  }));

  it("propagates directory chmod failures and performs no final mode sweep", () => run(async (directory) => {
    const { target, params } = await fixture(directory);
    const realOpen = fs.open.bind(fs);
    let closes = 0;
    let pinned = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === target && !pinned) {
        pinned = true;
        const close = handle.close.bind(handle);
        handle.close = async () => { closes++; await close(); };
        handle.chmod = async () => { throw Object.assign(new Error("injected directory chmod failure"), { code: "EIO" }); };
      }
      return handle;
    });
    await expect(mergeExtractedTreeIntoDestination(params)).rejects.toMatchObject({ code: "EIO" });
    expect(closes).toBe(1);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(path.join(target, "value"), "utf8")).toBe("NEW");
  }));

  it.each(["before-dispatch", "active-chmod", "opening"] as const)("joins %s timeout and closes the pinned directory exactly once", (stage) => run(async (directory) => {
    const { target, params } = await fixture(directory);
    await fs.mkdir(path.join(params.sourceDir, "zz-later"), { mode: 0o555 });
    const entered = deferred();
    const expired = deferred();
    const release = deferred();
    let closes = 0;
    let chmods = 0;
    let pinned = false;
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] !== target || pinned) return handle;
      pinned = true;
      const chmod = handle.chmod.bind(handle);
      const close = handle.close.bind(handle);
      handle.chmod = async (mode) => {
        chmods++;
        if (stage === "active-chmod") { entered.resolve(); await release.promise; }
        await chmod(mode);
      };
      handle.close = async () => { closes++; await close(); };
      if (stage === "opening") { entered.resolve(); await release.promise; }
      return handle;
    });
    __setFsSafeTestHooksForTest({ async beforeArchiveOutputMutation(operation, candidate) {
      if (operation === "chmod" && candidate === target && stage === "before-dispatch") {
        entered.resolve(); await release.promise;
      }
    } });
    let settled = false;
    const merge = withExtractionDeadline(500, "directory merge", async (deadline) => {
      deadline.signal.addEventListener("abort", expired.resolve, { once: true });
      await mergeExtractedTreeIntoDestination({ ...params, deadline });
    });
    void merge.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise;
      await expired.promise;
      expect(settled).toBe(false);
      expect(closes).toBe(0);
    } finally { release.resolve(); }
    await expect(merge).rejects.toThrow("directory merge timed out");
    expect(closes).toBe(1);
    expect(chmods).toBe(stage === "active-chmod" ? 1 : 0);
    expect((await fs.stat(target)).mode & 0o777).toBe(stage === "active-chmod" ? 0o555 : 0o700);
    await expect(fs.stat(path.join(params.destinationDir, "zz-later"))).rejects.toMatchObject({ code: "ENOENT" });
    const after = chmods;
    await new Promise<void>((done) => setImmediate(done));
    expect(chmods).toBe(after);
  }));
});
