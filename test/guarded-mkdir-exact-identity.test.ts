import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirPathComponentsWithGuards } from "../src/guarded-mkdir.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const descendantBranches = ["ordinary", "symlink-resolved"] as const;
type DescendantBranch = typeof descendantBranches[number];
type ExactIdentity = Readonly<{ dev: bigint; ino: bigint }>;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

function projectIdentity<T extends Stats | BigIntStats>(stat: T, identity: ExactIdentity): T {
  return Object.assign(Object.create(stat), {
    dev: typeof stat.dev === "bigint" ? identity.dev : Number(identity.dev),
    ino: typeof stat.ino === "bigint" ? identity.ino : Number(identity.ino),
  });
}

function requestsBigint(options: unknown): boolean {
  return typeof options === "object" && options !== null &&
    "bigint" in options && (options as { bigint?: boolean }).bigint === true;
}

function samePath(candidate: unknown, expected: string): boolean {
  const left = path.resolve(String(candidate));
  const right = path.resolve(expected);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function descendantFixture(branch: DescendantBranch, prefix: string) {
  const rootDir = await tempRoot(prefix);
  if (branch === "ordinary") {
    const guardedPath = path.join(rootDir, "descendant");
    return {
      childPath: path.join(guardedPath, "child"),
      firstComponent: guardedPath,
      guardedPath,
      rootDir,
      targetPath: path.join(guardedPath, "child"),
    };
  }

  const realDescendant = path.join(rootDir, "real-descendant");
  const firstComponent = path.join(rootDir, "descendant-alias");
  await fs.mkdir(realDescendant);
  await fs.symlink(realDescendant, firstComponent, process.platform === "win32" ? "junction" : "dir");
  const guardedPath = await fs.realpath(realDescendant);
  return {
    childPath: path.join(guardedPath, "child"),
    firstComponent,
    guardedPath,
    rootDir,
    targetPath: path.join(firstComponent, "child"),
  };
}

describe("guarded mkdir exact descendant identity", () => {
  it.each(descendantBranches)("keeps the %s descendant guard exact on the normal path", async (branch) => {
    const fixture = await descendantFixture(branch, `fs-safe-mkdir-exact-${branch}-`);
    const lstat = fsSync.lstatSync.bind(fsSync);
    const observations: boolean[] = [];
    const knownIdentity = { dev: 9007199254740995n, ino: 9007199254740993n };
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const stat = lstat(...args);
      if (!samePath(args[0], fixture.guardedPath)) return stat;
      observations.push(requestsBigint(args[1]));
      return projectIdentity(stat, knownIdentity);
    }) as typeof fsSync.lstatSync);

    await expect(mkdirPathComponentsWithGuards({
      rootReal: fixture.rootDir,
      targetPath: fixture.targetPath,
    })).resolves.toBe(fixture.childPath);

    expect(observations).toEqual(branch === "ordinary"
      ? [false, true, true, true]
      : [true, true, true]);
    expect((await fs.lstat(fixture.childPath)).isDirectory()).toBe(true);
  });

  it.each(descendantBranches)(
    "rejects a permanently unknown Windows %s descendant before child creation",
    async (branch) => {
      const fixture = await descendantFixture(branch, `fs-safe-mkdir-unknown-${branch}-`);
      Object.defineProperty(process, "platform", { value: "win32" });
      const lstat = fsSync.lstatSync.bind(fsSync);
      let exactInspections = 0;
      vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
        const stat = lstat(...args);
        if (!samePath(args[0], fixture.guardedPath)) return stat;
        if (requestsBigint(args[1])) exactInspections += 1;
        return projectIdentity(stat, { dev: 0n, ino: 0n });
      }) as typeof fsSync.lstatSync);
      const visited: string[] = [];

      await expect(mkdirPathComponentsWithGuards({
        rootReal: fixture.rootDir,
        targetPath: fixture.targetPath,
        beforeComponent: (componentPath) => { visited.push(componentPath); },
      })).rejects.toMatchObject({ code: "path-mismatch" });

      expect(exactInspections).toBe(2);
      expect(visited).toEqual([fixture.firstComponent]);
      await expect(fs.lstat(fixture.childPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(descendantBranches)("recovers an unknown Windows %s descendant identity", async (branch) => {
    const fixture = await descendantFixture(branch, `fs-safe-mkdir-recover-${branch}-`);
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = fsSync.lstatSync.bind(fsSync);
    let exactInspections = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const stat = lstat(...args);
      if (!samePath(args[0], fixture.guardedPath) || !requestsBigint(args[1])) return stat;
      exactInspections += 1;
      return exactInspections === 1
        ? projectIdentity(stat, { dev: 0n, ino: BigInt(stat.ino) })
        : stat;
    }) as typeof fsSync.lstatSync);

    await expect(mkdirPathComponentsWithGuards({
      rootReal: fixture.rootDir,
      targetPath: fixture.targetPath,
    })).resolves.toBe(fixture.childPath);

    expect(exactInspections).toBe(4);
    expect((await fs.lstat(fixture.childPath)).isDirectory()).toBe(true);
  });

  it.each(descendantBranches)("rejects contradictory known Windows %s identity components", async (branch) => {
    const fixture = await descendantFixture(branch, `fs-safe-mkdir-contradictory-${branch}-`);
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = fsSync.lstatSync.bind(fsSync);
    let exactInspections = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const stat = lstat(...args);
      if (!samePath(args[0], fixture.guardedPath) || !requestsBigint(args[1])) return stat;
      exactInspections += 1;
      const identity = { dev: BigInt(stat.dev), ino: BigInt(stat.ino) };
      return exactInspections === 1
        ? projectIdentity(stat, { dev: 0n, ino: identity.ino })
        : projectIdentity(stat, { dev: identity.dev, ino: identity.ino + 1n });
    }) as typeof fsSync.lstatSync);

    await expect(mkdirPathComponentsWithGuards({
      rootReal: fixture.rootDir,
      targetPath: fixture.targetPath,
    })).rejects.toMatchObject({ code: "path-mismatch" });

    expect(exactInspections).toBe(2);
    await expect(fs.lstat(fixture.childPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a rounded-equal same-path replacement untouched", async () => {
    const rootDir = await tempRoot("fs-safe-mkdir-rounded-replacement-");
    const descendant = path.join(rootDir, "descendant");
    const replacement = path.join(rootDir, "replacement");
    const displaced = path.join(rootDir, "displaced");
    const childPath = path.join(descendant, "child");
    await fs.mkdir(descendant);
    await fs.writeFile(path.join(descendant, "marker"), "original");
    await fs.mkdir(replacement);
    await fs.writeFile(path.join(replacement, "marker"), "replacement");

    const originalIdentity = { dev: 9007199254740995n, ino: 9007199254740992n };
    const replacementIdentity = { ...originalIdentity, ino: originalIdentity.ino + 1n };
    expect(Number(originalIdentity.ino)).toBe(Number(replacementIdentity.ino));
    const lstat = fsSync.lstatSync.bind(fsSync);
    let targetInspections = 0;
    let swapped = false;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      if (!samePath(args[0], descendant)) return lstat(...args);
      targetInspections += 1;
      if (targetInspections === 3) {
        fsSync.renameSync(descendant, displaced);
        fsSync.renameSync(replacement, descendant);
        swapped = true;
      }
      return projectIdentity(lstat(...args), swapped ? replacementIdentity : originalIdentity);
    }) as typeof fsSync.lstatSync);
    const visited: string[] = [];

    await expect(mkdirPathComponentsWithGuards({
      rootReal: rootDir,
      targetPath: childPath,
      beforeComponent: (componentPath) => { visited.push(componentPath); },
    })).rejects.toMatchObject({ code: "path-mismatch" });

    expect(swapped).toBe(true);
    expect(targetInspections).toBe(3);
    expect(visited).toEqual([descendant]);
    await expect(fs.readFile(path.join(descendant, "marker"), "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(path.join(displaced, "marker"), "utf8")).resolves.toBe("original");
    await expect(fs.lstat(childPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
