import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/index.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const exactInode = 9_007_199_254_740_993n;
const collidingInode = exactInode - 1n;
const exactDevice = 17n;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

function project<T extends Stats | BigIntStats>(
  stat: T,
  ino = exactInode,
  dev = exactDevice,
): T {
  if (!stat.isFile()) return stat;
  const bigint = typeof stat.ino === "bigint";
  return Object.assign(Object.create(stat), {
    dev: bigint ? dev : Number(dev),
    ino: bigint ? ino : Number(ino),
  });
}

function mockOpenedIdentity(params: {
  target: string;
  pathIdentity?: (attempt: number, stat: Stats | BigIntStats) => Stats | BigIntStats;
  canonicalIdentity?: (attempt: number, stat: Stats | BigIntStats) => Stats | BigIntStats;
}) {
  const fstat = fsSync.fstatSync.bind(fsSync);
  const lstat = fsSync.lstatSync.bind(fsSync);
  const stat = fsSync.statSync.bind(fsSync);
  let opened = false;
  let pathAttempts = 0;
  let canonicalAttempts = 0;
  vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) => {
    const actual = fstat(...args);
    if (!actual.isFile()) return actual;
    opened = true;
    return project(actual);
  }) as typeof fsSync.fstatSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    const actual = lstat(...args);
    if (!opened || String(args[0]) !== params.target || !actual.isFile()) return actual;
    pathAttempts++;
    return params.pathIdentity?.(pathAttempts, actual) ?? project(actual);
  }) as typeof fsSync.lstatSync);
  vi.spyOn(fsSync, "statSync").mockImplementation(((...args: Parameters<typeof fsSync.statSync>) => {
    const actual = stat(...args);
    if (!opened || String(args[0]) !== params.target || !actual.isFile()) return actual;
    canonicalAttempts++;
    return params.canonicalIdentity?.(canonicalAttempts, actual) ?? project(actual);
  }) as typeof fsSync.statSync);
  return {
    pathAttempts: () => pathAttempts,
    canonicalAttempts: () => canonicalAttempts,
  };
}

async function existingFile() {
  const directory = await tempRoot("fs-safe-open-writable-identity-");
  const target = path.join(directory, "target");
  await fs.writeFile(target, "ORIGINAL");
  const capability = await root(directory);
  return { directory, target, capability };
}

describe("Root.openWritable exact identity admission", () => {
  it.each([
    ...(["replace", "update", "append"] as const).map(writeMode => ({
      name: `pathname collision before ${writeMode} access`, writeMode,
      identities: { pathIdentity: (_attempt: number, stat: Stats | BigIntStats) => project(stat, collidingInode) },
      error: { code: "path-mismatch", message: "path changed during write" },
      canonicalAttempts: undefined,
    })),
    {
      name: "first canonical-path collision", writeMode: "update" as const,
      identities: { canonicalIdentity: (_attempt: number, stat: Stats | BigIntStats) => project(stat, collidingInode) },
      error: { code: "path-mismatch" }, canonicalAttempts: undefined,
    },
    {
      name: "final fresh canonical-path collision", writeMode: "update" as const,
      identities: { canonicalIdentity: (attempt: number, stat: Stats | BigIntStats) =>
        project(stat, attempt === 1 ? exactInode : collidingInode) },
      error: { code: "path-mismatch" }, canonicalAttempts: 2,
    },
  ])("rejects a rounded $name", async ({ writeMode, identities, error, canonicalAttempts }) => {
    const { target, capability } = await existingFile();
    expect(Number(exactInode)).toBe(Number(collidingInode));
    const observations = mockOpenedIdentity({ target, ...identities });

    await expect(capability.openWritable("target", { writeMode })).rejects.toMatchObject(error);
    if (canonicalAttempts !== undefined) expect(observations.canonicalAttempts()).toBe(canonicalAttempts);
    expect(await fs.readFile(target, "utf8")).toBe("ORIGINAL");
  });

  it("retries one transient unknown Windows pathname identity", async () => {
    const { target, capability } = await existingFile();
    Object.defineProperty(process, "platform", { value: "win32" });
    const observations = mockOpenedIdentity({
      target,
      pathIdentity: (attempt, stat) => attempt === 1 ? project(stat, 0n, 0n) : project(stat),
    });

    const opened = await capability.openWritable("target", { writeMode: "update" });
    expect(observations.pathAttempts()).toBe(2);
    expect(typeof opened.stat.ino).toBe("number");
    expect("identity" in opened).toBe(false);
    await opened.handle.close();
    expect(await fs.readFile(target, "utf8")).toBe("ORIGINAL");
  });

  it.each(["persistent unknown", "known component changes", "retry disappears"] as const)(
    "fails closed when a Windows pathname is %s",
    async (scenario) => {
      const { target, capability } = await existingFile();
      Object.defineProperty(process, "platform", { value: "win32" });
      const missing = Object.assign(new Error("vanished during identity retry"), { code: "ENOENT" });
      const observations = mockOpenedIdentity({
        target,
        pathIdentity: (attempt, stat) => {
          if (scenario === "retry disappears" && attempt === 2) throw missing;
          if (scenario === "known component changes") {
            return attempt === 1
              ? project(stat, 0n, exactDevice)
              : project(stat, exactInode, exactDevice + 1n);
          }
          return project(stat, 0n, 0n);
        },
      });

      const pending = capability.openWritable("target", { writeMode: "replace" });
      if (scenario === "retry disappears") await expect(pending).rejects.toBe(missing);
      else await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
      expect(observations.pathAttempts()).toBe(2);
      expect(await fs.readFile(target, "utf8")).toBe("ORIGINAL");
    },
  );

  it("keeps the ordinary descriptor-stat count while returning numeric Stats", async () => {
    const { target, capability } = await existingFile();
    const fstat = fsSync.fstatSync.bind(fsSync);
    const precisions: string[] = [];
    vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) => {
      const observed = fstat(...args);
      if (observed.isFile()) precisions.push(typeof observed.ino);
      return observed;
    }) as typeof fsSync.fstatSync);

    const opened = await capability.openWritable("target", { writeMode: "update" });
    expect(precisions).toEqual(["number", "bigint"]);
    expect(typeof opened.stat.ino).toBe("number");
    await opened.handle.close();
  });

  it("removes an unchanged created file after append authority fails before dispatch", async () => {
    const directory = await tempRoot("fs-safe-open-writable-owned-cleanup-");
    const target = path.join(directory, "target");
    const capability = await root(directory);
    const failure = new Error("authority withdrawn before append");
    let authorityChecks = 0;

    await expect(capability.append("target", "payload", {
      durable: false,
      assertBeforeMutation() {
        authorityChecks++;
        if (authorityChecks === 2) throw failure;
      },
    })).rejects.toBe(failure);

    expect(authorityChecks).toBe(2);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe.skipIf(process.platform === "win32")("exact created-file cleanup", () => {
  it("preserves a replacement whose numeric identity collides", async () => {
    const directory = await tempRoot("fs-safe-open-writable-cleanup-");
    const target = path.join(directory, "target");
    const displaced = path.join(directory, "displaced");
    const capability = await root(directory);
    let swapped = false;
    mockOpenedIdentity({
      target,
      pathIdentity: (_attempt, stat) => project(stat, swapped ? collidingInode : exactInode),
      canonicalIdentity: (_attempt, stat) => project(stat, swapped ? collidingInode : exactInode),
    });
    const failure = new Error("authority withdrawn before append");
    let authorityChecks = 0;

    await expect(capability.append("target", "payload", {
      durable: false,
      assertBeforeMutation() {
        authorityChecks++;
        if (authorityChecks !== 2) return;
        fsSync.renameSync(target, displaced);
        fsSync.writeFileSync(target, "REPLACEMENT");
        swapped = true;
        throw failure;
      },
    })).rejects.toBe(failure);

    expect(Number(exactInode)).toBe(Number(collidingInode));
    expect(await fs.readFile(target, "utf8")).toBe("REPLACEMENT");
    expect(await fs.readFile(displaced, "utf8")).toBe("");
  });
});
