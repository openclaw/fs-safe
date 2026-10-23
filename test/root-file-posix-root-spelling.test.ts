import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRootFileFinalAdmission, observeCanonicalRoot } from "../src/root-file-final-admission.js";
import { openRootFile, openRootFileSync } from "../src/root-file.js";
import { realpathSync } from "../src/realpath.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const configuredRoot = "/fixture/clawd";
const physicalRoot = "/fixture/Clawd";

function directoryStat(ino = 22n): BigIntStats {
  return {
    dev: 11n, ino, isDirectory: () => true, isSymbolicLink: () => false,
  } as BigIntStats;
}

afterEach(() => vi.restoreAllMocks());

itPosix("binds native POSIX root spelling to its observed identity", () => {
  const inspect = vi.spyOn(fsSync, "lstatSync").mockImplementation((() =>
    directoryStat()) as typeof fsSync.lstatSync);
  const resolve = vi.spyOn(realpathSync, "native").mockReturnValue(physicalRoot);

  expect(observeCanonicalRoot(fsSync, configuredRoot)).toEqual({
    ok: true, path: physicalRoot, identity: { dev: 11n, ino: 22n },
  });
  expect(inspect.mock.calls.map(([candidate]) => candidate)).toEqual([configuredRoot, physicalRoot]);
  expect(resolve).toHaveBeenCalledExactlyOnceWith(configuredRoot);
});

itPosix.each(["replacement", "symlink", "missing"] as const)(
  "rejects %s while binding native POSIX root spelling",
  scenario => {
    vi.spyOn(realpathSync, "native").mockReturnValue(physicalRoot);
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((candidate) => {
      if (candidate === configuredRoot) return directoryStat();
      if (scenario === "missing") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (scenario === "replacement") return directoryStat(23n);
      return { ...directoryStat(), isSymbolicLink: () => true };
    }) as typeof fsSync.lstatSync);

    expect(observeCanonicalRoot(fsSync, configuredRoot)).toMatchObject({
      ok: false, error: { code: "path-mismatch" },
    });
  },
);

it.runIf(process.platform === "darwin").for(
  (["async", "sync"] as const).flatMap(mode => [false, true].map(explicit => ({ mode, explicit }))),
)("opens a mixed-case APFS root ($mode, rootRealPath=$explicit)", async ({ mode, explicit }, context) => {
  const container = await tempRoot("fs-safe-case-root-");
  const physical = path.join(container, "Clawd");
  const configured = path.join(container, "clawd");
  await fs.mkdir(physical);
  if (!fsSync.existsSync(configured)) context.skip();
  const target = path.join(configured, "SKILL.md");
  await fs.writeFile(path.join(physical, "SKILL.md"), "inside");
  const params = {
    rootPath: configured, absolutePath: target, boundaryLabel: "skill root",
    ...(explicit ? { rootRealPath: fsSync.realpathSync(configured) } : {}),
  };
  const opened = mode === "async" ? await openRootFile(params) : openRootFileSync(params);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  try {
    expect(opened.rootRealPath).toBe(fsSync.realpathSync.native(physical));
    expect(opened.path).toBe(fsSync.realpathSync.native(target));
    expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("inside");
  } finally {
    fsSync.closeSync(opened.fd);
  }
});

itPosix("keeps differently cased directories distinct on a case-sensitive filesystem", async context => {
  const container = await tempRoot("fs-safe-distinct-case-root-");
  const trusted = path.join(container, "Clawd");
  const outside = path.join(container, "clawd");
  await fs.mkdir(trusted);
  if (fsSync.existsSync(outside)) context.skip();
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "SKILL.md"), "outside");
  const target = path.join(outside, "SKILL.md");
  expect(openRootFileSync({
    rootPath: trusted, absolutePath: target, boundaryLabel: "skill root",
  })).toMatchObject({
    ok: false, reason: "validation", error: { message: expect.stringContaining("Path escapes skill root") },
  });
  const observed = observeCanonicalRoot(fsSync, trusted);
  expect(observed.ok).toBe(true);
  if (!observed.ok) throw observed.error;
  const admit = createRootFileFinalAdmission(fsSync, observed, "skill root");
  expect(() => admit({ path: target, descriptorIdentity: fsSync.statSync(target, { bigint: true }) }))
    .toThrow(expect.objectContaining({ code: "outside-workspace" }));
});
