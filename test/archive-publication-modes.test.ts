import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { modeArchive, type ModeEntry } from "./helpers/archive-modes.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
const backends = native ? ["off", "require"] as const : ["off"] as const;
const nonRootPosix = process.platform !== "win32" && process.getuid?.() !== 0;

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture(kind: "tar" | "zip", entries: ModeEntry[]) {
  const base = await tempRoot("fs-safe-publication-modes-");
  const archivePath = path.join(base, `fixture.${kind}`);
  const destDir = path.join(base, "output");
  await fs.mkdir(destDir);
  await fs.writeFile(archivePath, await modeArchive(kind, entries));
  return { archivePath, destDir, kind, timeoutMs: 10000 };
}

// Inspect each owned directory before enabling traversal for child inspection/cleanup.
async function inspectTree(destDir: string, entries: ModeEntry[]) {
  const modes = new Map<string, number>();
  for (const entry of [...entries].sort((a, b) => a.path.split("/").filter(Boolean).length - b.path.split("/").filter(Boolean).length)) {
    const target = path.join(destDir, entry.path);
    const stat = await fs.stat(target);
    modes.set(entry.path, stat.mode & 0o7777);
    await fs.chmod(target, entry.directory ? 0o700 : 0o600);
    if (!entry.directory) expect(await fs.readFile(target, "utf8")).toBe("NEW");
  }
  return modes;
}

describe.skipIf(!nonRootPosix).each(backends)("%s real non-root publication modes", (backend) => {
  function configure() {
    if (native) __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: backend });
  }
  it.each([
    ["tar", 0o022], ["tar", 0o077], ["zip", 0o022], ["zip", 0o077],
  ] as const)("preserves %s file rwx under umask %s, including zero and special bits", async (kind, umask) => {
    configure();
    const previousUmask = process.umask(umask);
    try {
      const entries = [0, 0o200, 0o400, 0o710, 0o7777, 0o7000].map((mode) => ({ path: `mode-${mode}`, mode }));
      const params = await fixture(kind, entries);
      for (const entry of entries) await fs.writeFile(path.join(params.destDir, entry.path), "OLD");
      await extractArchive({ ...params, entryModes: "preserve" });
      const actual = await inspectTree(params.destDir, entries);
      for (const entry of entries) expect(actual.get(entry.path)).toBe(entry.mode & 0o777);
    } finally { process.umask(previousUmask); }
  });

  it.each([
    ["tar", 0o022, "before"], ["tar", 0o022, "after"],
    ["tar", 0o077, "before"], ["tar", 0o077, "after"],
    ["zip", 0o022, "before"], ["zip", 0o022, "after"],
    ["zip", 0o077, "before"], ["zip", 0o077, "after"],
  ] as const)("finalizes %s directories under umask %s with explicit entries %s children", async (kind, umask, order) => {
    configure();
    const previousUmask = process.umask(umask);
    try {
      const dirs: ModeEntry[] = [0, 0o100, 0o500, 0o555].flatMap((mode) => [
        { path: `dir-${mode}/`, directory: true, mode },
        { path: `dir-${mode}/nested/`, directory: true, mode: 0 },
        { path: `empty-${mode}/`, directory: true, mode },
      ]);
      const files: ModeEntry[] = [0, 0o100, 0o500, 0o555].map((mode) => ({ path: `dir-${mode}/nested/value`, mode: 0o200 }));
      files.push({ path: "bin/tool", mode: 0o755 });
      const entries = order === "before" ? [...dirs, ...files] : [...files, ...dirs];
      const params = await fixture(kind, entries);
      await extractArchive({ ...params, entryModes: "preserve" });
      const expected = [...entries, { path: "bin/", directory: true, mode: 0o755 }];
      const actual = await inspectTree(params.destDir, expected);
      for (const entry of expected) expect(actual.get(entry.path)).toBe(entry.mode! & 0o777);
    } finally { process.umask(previousUmask); }
  });

  it.each(["tar", "zip"] as const)("clamps %s files and implicit parents and calls strip/filter policy once", async (kind) => {
    configure();
    const entries = [
      { path: "pkg/bin/tool", mode: 0o710 }, { path: "pkg/value", mode: 0 },
      { path: "pkg/skip", mode: 0o200 },
    ];
    const params = await fixture(kind, entries);
    const seen: string[] = [];
    await extractArchive({ ...params, stripComponents: 1, onFiltered: "skip-entry", entryFilter: ({ path }) => {
      seen.push(path); return path === "pkg/skip" ? "skip" : "extract";
    } });
    expect(seen).toEqual(entries.map((entry) => entry.path));
    const actual = await inspectTree(params.destDir, [
      { path: "bin/", directory: true }, { path: "bin/tool" }, { path: "value" },
    ]);
    expect(Object.fromEntries(actual)).toEqual({ "bin/": 0o755, value: 0o644, "bin/tool": 0o755 });
    await expect(fs.stat(path.join(params.destDir, "skip"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("distinguishes absent ZIP metadata from explicit UNIX zero", async () => {
    configure();
    const entries: ModeEntry[] = [
      { path: "absent", mode: null }, { path: "zero", mode: 0 },
      { path: "absent-dir/", directory: true, mode: null }, { path: "zero-dir/", directory: true, mode: 0 },
    ];
    const params = await fixture("zip", entries);
    await extractArchive({ ...params, entryModes: "preserve" });
    const actual = await inspectTree(params.destDir, entries);
    expect(Object.fromEntries(actual)).toEqual({ absent: 0o644, zero: 0, "absent-dir/": 0o755, "zero-dir/": 0 });
  });

  it.each(["tar", "zip"] as const)("keeps %s explicit directory modes after strip/filter admission", async (kind) => {
    configure();
    const entries: ModeEntry[] = [
      { path: "pkg/restricted/", directory: true, mode: 0 },
      { path: "pkg/restricted/value", mode: 0o400 },
      { path: "pkg/skipped/", directory: true, mode: 0 },
      { path: "pkg/skipped/value", mode: 0o200 },
    ];
    const params = await fixture(kind, entries);
    const seen: string[] = [];
    await extractArchive({ ...params, stripComponents: 1, entryModes: "preserve", onFiltered: "skip-entry", entryFilter: (entry) => {
      seen.push(entry.path);
      return entry.path === "pkg/skipped" ? "skip" : "extract";
    } });
    expect(seen).toEqual(["pkg/restricted", "pkg/restricted/value", "pkg/skipped", "pkg/skipped/value"]);
    const actual = await inspectTree(params.destDir, entries.map((entry) => ({ ...entry, path: entry.path.slice(4) })));
    expect(Object.fromEntries(actual)).toEqual({ "restricted/": 0, "restricted/value": 0o400, "skipped/": 0o755, "skipped/value": 0o200 });
  });

  it.each(["tar", "zip"] as const)("associates %s modes with staged Unicode and case identity", async (kind) => {
    configure();
    const params = await fixture(kind, [
      { path: "Dir/é", mode: 0o200 }, { path: "dir/", directory: true, mode: 0o500 },
    ]);
    await extractArchive({ ...params, entryModes: "preserve" });
    const parents = await fs.readdir(params.destDir);
    const mergedCase = parents.length === 1;
    expect((await fs.stat(path.join(params.destDir, "Dir"))).mode & 0o777).toBe(mergedCase ? 0o500 : 0o755);
    expect((await fs.stat(path.join(params.destDir, "dir"))).mode & 0o777).toBe(0o500);
    await fs.chmod(path.join(params.destDir, "dir"), 0o700);
    const actual = await inspectTree(params.destDir, [{ path: "Dir/é" }]);
    expect(actual.get("Dir/é")).toBe(0o200);
  });
});
