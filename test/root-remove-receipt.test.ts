import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  Object.defineProperty(process, "platform", platform);
});

it.each([0, 2, 8].flatMap(depth => ["file", "directory"].map(kind => ({ depth, kind }))))(
  "shares resolution observations with both $kind removal fences at depth $depth",
  async ({ depth, kind }) => {
    const directory = await tempRoot("fs-safe-remove-receipt-budget-");
    configureFsSafeNative({ mode: "off" });
    const scoped = await root(directory);
    const boundaries = [scoped.rootReal];
    for (let index = 0; index < depth; index++) boundaries.push(path.join(boundaries.at(-1)!, `level-${index}`));
    const parent = boundaries.at(-1)!;
    const target = path.join(parent, "target");
    await fs.mkdir(parent, { recursive: true });
    if (kind === "file") await fs.writeFile(target, "value");
    else await fs.mkdir(target);
    const observed = new Map(boundaries.map(dir => [dir, { exact: 0, numeric: 0, unknown: 0 }]));
    const canonicalPaths: string[] = [];
    const lstat = fsSync.lstatSync.bind(fsSync);
    const canonicalize = realpathSync.native;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const stat = lstat(...args);
      const count = observed.get(String(args[0]));
      if (count) {
        count[(args[1] as { bigint?: boolean } | undefined)?.bigint ? "exact" : "numeric"]++;
        if (process.platform === "win32" && (BigInt(stat.dev) === 0n || BigInt(stat.ino) === 0n)) count.unknown++;
      }
      return stat;
    }) as typeof fsSync.lstatSync);
    vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      if (observed.has(String(candidate))) canonicalPaths.push(String(candidate));
      return canonicalize(candidate);
    });

    await scoped.remove(path.relative(scoped.rootReal, target));

    expect(canonicalPaths).toEqual([parent, parent, parent]);
    for (const count of observed.values()) {
      expect(count.numeric).toBe(0);
      // Each admitted observation plus the two current-identity fences. Each
      // strict Windows observation may use at most one unknown-ID retry.
      expect(count.exact).toBe(3 + count.unknown);
      expect(count.exact).toBeLessThanOrEqual(6);
    }
  },
);

it.each(["before", "after"] as const)("retains an intermediate identity %s dispatch even when the parent is unchanged", async phase => {
  const directory = await tempRoot("fs-safe-remove-receipt-intermediate-");
  const ancestor = path.join(directory, "ancestor");
  const parent = path.join(ancestor, "parent");
  const target = path.join(parent, "target");
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(target, "value");
  const scoped = await root(directory);
  const saved = path.join(directory, "saved");
  const firstInode = 9007199254740992n;
  expect(Number(firstInode)).toBe(Number(firstInode + 1n));
  let changed = false;
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    const stat = lstat(...args);
    if (String(args[0]) !== ancestor) return stat;
    const ino = changed ? firstInode + 1n : firstInode;
    return Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
  }) as typeof fsSync.lstatSync);
  const replaceAncestor = async () => {
    await fs.rename(ancestor, saved);
    await fs.mkdir(ancestor);
    await fs.rename(path.join(saved, "parent"), parent);
    changed = true;
  };
  const unlink = fs.unlink.bind(fs);
  const dispatch = vi.spyOn(fs, "unlink").mockImplementation(async candidate => {
    await unlink(candidate);
    if (phase === "after") await replaceAncestor();
  });
  if (phase === "before") __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: replaceAncestor });

  await expect(scoped.remove("ancestor/parent/target", { force: true })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(changed).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
  if (phase === "before") expect(await fs.readFile(target, "utf8")).toBe("value");
  else await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["before", "after"].flatMap(phase => [false, true].map(nested => ({ phase, nested }))))(
  "reports Root loss $phase dispatch (nested=$nested)", async ({ phase, nested }) => {
    const base = await tempRoot("fs-safe-remove-receipt-root-");
    const directory = path.join(base, "root");
    const relative = nested ? "ancestor/parent/target" : "target";
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "value");
    const scoped = await root(directory);
    const loseRoot = async () => { await fs.rename(directory, path.join(base, "saved")); };
    if (phase === "before") __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: loseRoot });
    else {
      const unlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementationOnce(async candidate => { await unlink(candidate); await loseRoot(); });
    }
    await expect(scoped.remove(relative, { force: true })).rejects.toMatchObject({
      code: phase === "after" && !nested ? "not-found" : "path-mismatch",
    });
  },
);

it.each(["intermediate", "parent"].flatMap(boundary =>
  ["device", "inode", "persistent", "changed known", "alternating", "numeric", "symlink"].map(scenario => ({ boundary, scenario }))))(
  "retains strict Windows seeded identity admission for $boundary: $scenario", async ({ boundary, scenario }) => {
    const directory = await tempRoot("fs-safe-remove-receipt-unknown-");
    const ancestor = path.join(directory, "ancestor");
    const parent = path.join(ancestor, "parent");
    const target = path.join(parent, "target");
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(target, "value");
    const scoped = await root(directory);
    const observedPath = boundary === "parent" ? parent : ancestor;
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = fsSync.lstatSync.bind(fsSync);
    let inspections = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const stat = lstat(...args);
      if (String(args[0]) !== observedPath) return stat;
      expect(typeof stat.ino).toBe("bigint");
      const first = ++inspections === 1;
      if (scenario === "numeric") return Object.assign(Object.create(stat), { dev: Number(stat.dev), ino: Number(stat.ino) });
      if (scenario === "symlink" && !first) return Object.assign(Object.create(stat), { isSymbolicLink: () => true });
      if (scenario === "alternating") return Object.assign(Object.create(stat), first ? { dev: 0n } : { ino: 0n });
      if (scenario === "changed known" && first) return Object.assign(Object.create(stat), { dev: 0n, ino: BigInt(stat.ino) + 1n });
      if (first || scenario === "persistent") return Object.assign(Object.create(stat), scenario === "inode" ? { ino: 0n } : { dev: 0n });
      return stat;
    }) as typeof fsSync.lstatSync);
    const pending = scoped.remove("ancestor/parent/target", { force: true });
    if (scenario === "device" || scenario === "inode") {
      await pending;
      expect(inspections).toBe(4);
    } else {
      await expect(pending).rejects.toMatchObject({ code: scenario === "symlink" ? "not-file" : "path-mismatch" });
      expect(inspections).toBe(scenario === "numeric" ? 1 : 2);
      expect(await fs.readFile(target, "utf8")).toBe("value");
    }
  },
);
