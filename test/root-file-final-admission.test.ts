import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  openRootFile,
  openRootFileSync,
  type OpenRootFileParams,
  type OpenRootFileSyncParams,
} from "../src/root-file.js";
import { realpathSync } from "../src/realpath.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
type BoundaryFs = NonNullable<OpenRootFileSyncParams["ioFs"]>;
type OpenMode = "async" | "sync";

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

async function fixture(prefix: string) {
  const container = await tempRoot(prefix);
  const boundary = path.join(container, "boundary");
  const parent = path.join(boundary, "parent");
  const outside = path.join(container, "outside");
  await fs.mkdir(parent, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(parent, "value"), "inside");
  await fs.writeFile(path.join(outside, "value"), "outside");
  return {
    boundary,
    parent,
    outside,
    target: path.join(parent, "value"),
  };
}

function passthroughFs(overrides: Partial<BoundaryFs> = {}): BoundaryFs {
  return {
    constants: fsSync.constants,
    closeSync: fsSync.closeSync,
    fstatSync: fsSync.fstatSync,
    lstatSync: fsSync.lstatSync,
    openSync: fsSync.openSync,
    readFileSync: fsSync.readFileSync,
    realpathSync: fsSync.realpathSync,
    ...overrides,
  } as BoundaryFs;
}

async function openInMode(
  mode: OpenMode,
  params: OpenRootFileParams,
) {
  return mode === "async" ? await openRootFile(params) : openRootFileSync(params);
}

function replaceDirectoryWithAlias(directory: string, replacement: string): void {
  fsSync.renameSync(directory, `${directory}.saved`);
  fsSync.symlinkSync(replacement, directory, "dir");
}

const finalFencePhases = [
  "first root identity",
  "canonical boundary admission",
  "canonical leaf identity",
  "second root identity",
] as const;

itPosix.each(
  (["async", "sync"] as const).flatMap(mode =>
    finalFencePhases.map(phase => ({ mode, phase }))),
)("rejects substitution at the $phase check ($mode)", async ({ mode, phase }) => {
  const { boundary, parent, outside, target } = await fixture("fs-safe-root-file-fence-");
  let rootLstats = 0;
  let leafLstats = 0;
  let swapped = false;
  const closes: number[] = [];
  const reads: string[] = [];
  const realpath = ((candidate: fsSync.PathLike) => {
    const canonical = fsSync.realpathSync(candidate);
    if (phase === "canonical leaf identity" && !swapped) {
      swapped = true;
      fsSync.renameSync(target, `${target}.saved`);
      fsSync.writeFileSync(target, "replacement");
    }
    return canonical;
  }) as BoundaryFs["realpathSync"];
  realpath.native = fsSync.realpathSync.native;
  const ioFs = passthroughFs({
    closeSync(fd) {
      closes.push(fd);
      fsSync.closeSync(fd);
    },
    lstatSync: ((candidate: fsSync.PathLike, options?: { bigint?: boolean }) => {
      const pathname = String(candidate);
      if (pathname === boundary) {
        rootLstats++;
        if (rootLstats === 2 && phase === "first root identity" && !swapped) {
          swapped = true;
          replaceDirectoryWithAlias(boundary, outside);
        }
        const stat = fsSync.lstatSync(candidate, options as never);
        if (rootLstats === 2 && phase === "canonical boundary admission" && !swapped) {
          swapped = true;
          replaceDirectoryWithAlias(parent, outside);
        }
        return stat;
      }
      if (pathname === target) {
        leafLstats++;
        const stat = fsSync.lstatSync(candidate, options as never);
        if (leafLstats === 3 && phase === "second root identity" && !swapped) {
          swapped = true;
          replaceDirectoryWithAlias(boundary, outside);
        }
        return stat;
      }
      return fsSync.lstatSync(candidate, options as never);
    }) as BoundaryFs["lstatSync"],
    readFileSync: ((...args: Parameters<typeof fsSync.readFileSync>) => {
      reads.push(String(args[0]));
      return fsSync.readFileSync(...args);
    }) as BoundaryFs["readFileSync"],
    realpathSync: realpath,
  });

  const opened = await openInMode(mode, {
    absolutePath: target,
    rootPath: boundary,
    boundaryLabel: "fixture root",
    ioFs,
  });

  expect(swapped).toBe(true);
  expect(opened).toMatchObject({ ok: false, reason: "validation" });
  expect(closes).toHaveLength(1);
  expect(reads).toEqual([]);
});

it.each(["async", "sync"] as const)(
  "returns a numeric receipt after complete final admission (%s)",
  async mode => {
    const { boundary, target } = await fixture("fs-safe-root-file-success-");
    const calls: string[] = [];
    const realpath = ((candidate: fsSync.PathLike) => {
      calls.push("realpath");
      return fsSync.realpathSync(candidate);
    }) as BoundaryFs["realpathSync"];
    realpath.native = fsSync.realpathSync.native;
    const ioFs = passthroughFs({
      fstatSync: ((...args: Parameters<typeof fsSync.fstatSync>) => {
        calls.push(args[1]?.bigint ? "fstat:bigint" : "fstat:numeric");
        return fsSync.fstatSync(...args);
      }) as BoundaryFs["fstatSync"],
      lstatSync: ((...args: Parameters<typeof fsSync.lstatSync>) => {
        calls.push("lstat");
        return fsSync.lstatSync(...args);
      }) as BoundaryFs["lstatSync"],
      openSync: ((...args: Parameters<typeof fsSync.openSync>) => {
        calls.push("open");
        return fsSync.openSync(...args);
      }) as BoundaryFs["openSync"],
      realpathSync: realpath,
    });

    const opened = await openInMode(mode, {
      absolutePath: target,
      rootPath: boundary,
      boundaryLabel: "fixture root",
      ioFs,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw opened.error;
    try {
      expect(opened.path).toBe(target);
      expect(opened.rootRealPath).toBe(boundary);
      expect(typeof opened.stat.dev).toBe("number");
      expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("inside");
      expect(calls).toEqual([
        "lstat",
        "lstat",
        "open",
        "fstat:numeric",
        "fstat:bigint",
        "lstat",
        "lstat",
        "realpath",
        "lstat",
        "lstat",
      ]);
    } finally {
      fsSync.closeSync(opened.fd);
    }
  },
);

it("uses the native realpath wrapper for the built-in adapter's final check", async () => {
  const { boundary, target } = await fixture("fs-safe-root-file-native-realpath-");
  const native = realpathSync.native;
  const observed = vi.spyOn(realpathSync, "native").mockImplementation(native);

  const opened = openRootFileSync({
    absolutePath: target,
    rootPath: boundary,
    rootRealPath: boundary,
    boundaryLabel: "fixture root",
  });

  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  fsSync.closeSync(opened.fd);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(observed).toHaveBeenCalledWith(target);
});

it.each(["async", "sync"] as const)(
  "admits contained aliases and directories through the final fence (%s)",
  async mode => {
    const { boundary, parent } = await fixture("fs-safe-root-file-alias-");
    const alias = path.join(boundary, "alias");
    await fs.symlink(parent, alias, process.platform === "win32" ? "junction" : "dir");
    const opened = await openInMode(mode, {
      absolutePath: alias,
      rootPath: boundary,
      boundaryLabel: "fixture root",
      symlinks: "follow-within-root",
      allowedType: "directory",
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw opened.error;
    try {
      expect(opened.path).toBe(parent);
      expect(opened.stat.isDirectory()).toBe(true);
    } finally {
      fsSync.closeSync(opened.fd);
    }
  },
);

it.each(["async", "sync"] as const)(
  "preserves missing-root and missing-path classifications (%s)",
  async mode => {
    const container = await tempRoot("fs-safe-root-file-missing-");
    const missingRoot = path.join(container, "missing-root");
    const missingRootResult = await openInMode(mode, {
      absolutePath: path.join(missingRoot, "value"),
      rootPath: missingRoot,
      boundaryLabel: "missing root",
    });
    expect(missingRootResult).toMatchObject({ ok: false, reason: "path" });

    const missingPathResult = await openInMode(mode, {
      absolutePath: path.join(container, "missing-value"),
      rootPath: container,
      boundaryLabel: "fixture root",
    });
    expect(missingPathResult).toMatchObject({ ok: false, reason: "path" });
  },
);

it.each([
  { code: "ENOENT", reason: "path" },
  { code: "EACCES", reason: "io" },
] as const)("preserves final realpath $code as a $reason failure", async ({ code, reason }) => {
  const { boundary, target } = await fixture("fs-safe-root-file-realpath-error-");
  const failure = Object.assign(new Error("final realpath failed"), { code });
  const closes: number[] = [];
  const realpath = (() => { throw failure; }) as BoundaryFs["realpathSync"];
  realpath.native = fsSync.realpathSync.native;
  const opened = openRootFileSync({
    absolutePath: target,
    rootPath: boundary,
    boundaryLabel: "fixture root",
    ioFs: passthroughFs({
      closeSync(fd) {
        closes.push(fd);
        fsSync.closeSync(fd);
      },
      realpathSync: realpath,
    }),
  });

  expect(opened).toEqual({ ok: false, reason, error: failure });
  expect(closes).toHaveLength(1);
});

it("preserves a canonical-root observation I/O failure without opening", async () => {
  const { boundary, target } = await fixture("fs-safe-root-file-root-error-");
  const failure = Object.assign(new Error("root observation denied"), { code: "EACCES" });
  let opens = 0;
  const ioFs = passthroughFs({
    lstatSync: ((candidate: fsSync.PathLike, options?: { bigint?: boolean }) => {
      if (String(candidate) === boundary) throw failure;
      return fsSync.lstatSync(candidate, options as never);
    }) as BoundaryFs["lstatSync"],
    openSync(...args: Parameters<typeof fsSync.openSync>) {
      opens++;
      return fsSync.openSync(...args);
    },
  });

  const opened = await openRootFile({
    absolutePath: target,
    rootPath: boundary,
    boundaryLabel: "fixture root",
    ioFs,
  });

  expect(opened).toEqual({ ok: false, reason: "io", error: failure });
  expect(opens).toBe(0);
});

it.each([
  { stage: "root capture", rootAttempt: 1 },
  { stage: "first root verification", rootAttempt: 2 },
  { stage: "canonical leaf verification", leafAttempt: 3 },
  { stage: "second root verification", rootAttempt: 3 },
])("retries a transient unknown Windows $stage without reopening", async ({
  rootAttempt,
  leafAttempt,
}) => {
  const { boundary, target } = await fixture("fs-safe-root-file-windows-identity-");
  Object.defineProperty(process, "platform", { value: "win32" });
  let rootLstats = 0;
  let leafLstats = 0;
  let opens = 0;
  let injected = false;
  const ioFs = passthroughFs({
    lstatSync: ((candidate: fsSync.PathLike, options?: { bigint?: boolean }) => {
      const stat = fsSync.lstatSync(candidate, options as never);
      if (String(candidate) === boundary) rootLstats++;
      if (String(candidate) === target) leafLstats++;
      if (!injected && (
        (rootAttempt !== undefined && String(candidate) === boundary && rootLstats === rootAttempt) ||
        (leafAttempt !== undefined && String(candidate) === target && leafLstats === leafAttempt)
      )) {
        injected = true;
        return Object.assign(Object.create(stat), { dev: 0n });
      }
      return stat;
    }) as BoundaryFs["lstatSync"],
    openSync(...args: Parameters<typeof fsSync.openSync>) {
      opens++;
      return fsSync.openSync(...args);
    },
  });

  const opened = await openRootFile({
    absolutePath: target,
    rootPath: boundary,
    boundaryLabel: "fixture root",
    ioFs,
  });

  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  fsSync.closeSync(opened.fd);
  expect(injected).toBe(true);
  expect(rootLstats).toBe(rootAttempt === undefined ? 3 : 4);
  expect(leafLstats).toBe(leafAttempt === undefined ? 3 : 4);
  expect(opens).toBe(1);
});
