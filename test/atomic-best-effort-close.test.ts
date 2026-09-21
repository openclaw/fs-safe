import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  replaceFileAtomic, replaceFileAtomicSync,
  type ReplaceFileAtomicFileSystem,
} from "../src/atomic.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const FAILURES = [
  { label: "Error with cause", value: new Error("close failed", { cause: new Error("close cause") }) },
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "positive zero", value: 0 },
  { label: "negative zero", value: -0 },
  { label: "bigint zero", value: 0n },
  { label: "empty string", value: "" },
  { label: "NaN", value: Number.NaN },
] as const;
const CLOSE_CASES = FAILURES.flatMap((failure, index) =>
  (["throw", "reject"] as const).map(delivery => ({
    ...failure, delivery, primary: FAILURES[(index + 1) % FAILURES.length]!.value,
  })));
type Route = "hardlinks-rename" | "hardlinks-fallback" | "parent-sync" | "replacement-pin" | "replacement-content";

function bindHandle(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileHandle];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runAdapter(params: {
  directory: string;
  target: string;
  route: Route;
  delivery: "throw" | "reject";
  closeFailure: unknown;
  primary?: unknown;
}) {
  let closes = 0, stageCloses = 0, targetOpens = 0, renames = 0;
  const retained: FileHandle[] = [];
  const fileSystem: ReplaceFileAtomicFileSystem = {
    promises: {
      ...fs,
      async open(...args: Parameters<typeof fs.open>) {
        const handle = await fs.open(...args);
        const candidate = String(args[0]);
        if (params.route.startsWith("replacement") && args[1] === "wx" &&
          candidate.startsWith(path.join(params.directory, ".fs-safe-replace."))) {
          return bindHandle(handle, {
            async close() {
              stageCloses++;
              await handle.close();
              if (params.route === "replacement-pin") throw params.primary;
            },
          });
        }
        if (candidate === params.target) targetOpens++;
        const selected = params.route === "parent-sync"
          ? candidate === params.directory && args[1] === "r"
          : candidate === params.target &&
            (params.route !== "hardlinks-fallback" || targetOpens === 2);
        if (!selected) return handle;
        retained.push(handle);
        return bindHandle(handle, {
          close() {
            closes++;
            if (params.delivery === "throw") throw params.closeFailure;
            return Promise.reject(params.closeFailure);
          },
        });
      },
      async rename(from, to) {
        renames++;
        if (params.route === "hardlinks-fallback") {
          throw Object.assign(new Error("force copy fallback"), { code: "EPERM" });
        }
        if (params.route.startsWith("replacement")) {
          if (params.route === "replacement-content") await fs.writeFile(to, "substitute");
          else await fs.copyFile(from, to);
          await fs.unlink(from);
        } else await fs.rename(from, to);
      },
    },
  };
  let outcome: { ok: true; method: string } | { ok: false; error: unknown };
  try {
    const result = await replaceFileAtomic({
      filePath: params.target,
      content: "replacement",
      fileSystem,
      syncTempFile: false,
      syncParentDir: params.route === "parent-sync",
      ...(params.route.startsWith("hardlinks") ? { destinationHardlinks: "reject" } : {}),
      ...(params.route === "hardlinks-fallback" ? { copyFallbackOnPermissionError: true } : {}),
      ...(params.route.startsWith("replacement") ? { renameIdentity: "verify-content-with-lock" } : {}),
    });
    outcome = { ok: true, method: result.method };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    // Failed adapter closes leave their real handles for fixture-owned disposal.
    await Promise.all(retained.map(handle => handle.close()));
  }
  return { outcome, closes, stageCloses, targetOpens, renames };
}

async function exercise(route: Route, entry: typeof CLOSE_CASES[number]) {
  const directory = await tempRoot("fs-safe-best-effort-close-");
  const target = path.join(directory, "target");
  await fs.writeFile(target, "original");
  const result = await runAdapter({
    directory, target, route, delivery: entry.delivery,
    closeFailure: entry.value, primary: entry.primary,
  });
  if (route === "replacement-pin") {
    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) expect(Object.is(result.outcome.error, entry.primary)).toBe(true);
    expect(result.stageCloses).toBe(1);
  } else {
    expect(result.outcome).toEqual({ ok: true, method: route === "hardlinks-fallback" ? "copy-fallback" : "rename" });
  }
  expect(result.closes).toBe(1);
  expect(result.renames).toBe(1);
  await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
  expect((await fs.readdir(directory)).filter(name => name.startsWith(".fs-safe-replace."))).toEqual([]);
}

describe.each(["hardlinks-rename", "hardlinks-fallback", "replacement-pin"] as const)("async best-effort close: %s", route => {
  it.each(CLOSE_CASES)("handles $label delivered by $delivery", async entry => {
    await exercise(route, entry);
  });
});

itPosix.each(CLOSE_CASES)("parent-sync best-effort close handles $label delivered by $delivery", async entry => {
  await exercise("parent-sync", entry);
});

it.each(["throw", "reject"] as const)("preserves rejected replacement content when close uses %s", async delivery => {
  const directory = await tempRoot("fs-safe-replacement-content-close-");
  const target = path.join(directory, "target");
  await fs.writeFile(target, "original");
  const secondary = new Error("replacement close failed");
  const result = await runAdapter({ directory, target, route: "replacement-content", delivery, closeFailure: secondary });
  expect(result.outcome.ok).toBe(false);
  if (!result.outcome.ok) {
    expect(result.outcome.error).toMatchObject({ code: "path-mismatch" });
    expect(result.outcome.error).not.toBe(secondary);
  }
  expect(result.closes).toBe(1);
  expect(result.stageCloses).toBe(1);
  await expect(fs.readFile(target, "utf8")).resolves.toBe("substitute");
  expect((await fs.readdir(directory)).filter(name => name.startsWith(".fs-safe-replace."))).toEqual([]);
});

it.each(FAILURES)("still reports a successful synchronous hardlink-admission close failure: $label", async ({ value }) => {
  const directory = await tempRoot("fs-safe-sync-admission-close-");
  const target = path.join(directory, "target");
  await fs.writeFile(target, "original");
  const destinationFds = new Set<number>();
  let closes = 0, renames = 0;
  const fileSystem = {
    ...fsSync,
    openSync(candidate: fsSync.PathLike, flags: fsSync.OpenMode, mode?: fsSync.Mode) {
      const fd = fsSync.openSync(candidate, flags, mode);
      if (String(candidate) === target) destinationFds.add(fd);
      return fd;
    },
    closeSync(fd: number) {
      const destination = destinationFds.delete(fd);
      fsSync.closeSync(fd);
      if (destination) { closes++; throw value; }
    },
    renameSync(from: fsSync.PathLike, to: fsSync.PathLike) {
      renames++;
      fsSync.renameSync(from, to);
    },
  };
  const failure = { caught: false, error: undefined as unknown };
  try {
    replaceFileAtomicSync({ filePath: target, content: "replacement", fileSystem, destinationHardlinks: "reject" });
  } catch (error) { failure.caught = true; failure.error = error; }
  expect(failure.caught).toBe(true);
  expect(Object.is(failure.error, value)).toBe(true);
  expect(closes).toBe(1);
  expect(renames).toBe(0);
  await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
  expect((await fs.readdir(directory)).filter(name => name.startsWith(".fs-safe-replace."))).toEqual([]);
});

it.each(["throw", "reject"] as const)("still rejects a real destination hardlink when close uses %s", async delivery => {
  const directory = await tempRoot("fs-safe-hardlink-close-policy-");
  const target = path.join(directory, "target"), alias = path.join(directory, "alias");
  await fs.writeFile(target, "original");
  await fs.link(target, alias);
  const result = await runAdapter({ directory, target, route: "hardlinks-rename", delivery, closeFailure: new Error("close failed") });
  expect(result.outcome.ok).toBe(false);
  if (!result.outcome.ok) expect(result.outcome.error).toMatchObject({ code: "hardlink" });
  expect(result.closes).toBe(1);
  expect(result.renames).toBe(0);
  await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
  await expect(fs.readFile(alias, "utf8")).resolves.toBe("original");
});
