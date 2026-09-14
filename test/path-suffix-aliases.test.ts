import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { probePathSuffixAliasesSync } from "../src/path-suffix-aliases.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

function directObservation(directory: string, left: string, right: string): boolean {
  const first = path.join(directory, left);
  fs.mkdirSync(first, { recursive: true });
  try {
    const original = fs.lstatSync(first, { bigint: true });
    try {
      const alternate = fs.lstatSync(path.join(directory, right), { bigint: true });
      return original.dev === alternate.dev && original.ino === alternate.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  } finally {
    fs.rmSync(path.join(directory, left.split(path.sep)[0]!), { recursive: true });
  }
}

it.each([
  ["Worker.sqlite", "worker.sqlite"],
  ["éWorker.sqlite", "éworker.sqlite"],
  ["É", "é"],
  ["σ.sqlite", "ς.sqlite"],
  ["É.sqlite", "e\u0301.sqlite"],
  ["ÉA.sqlite", "E\u0301a.sqlite"],
  ["café.sqlite", "cafe\u0301.sqlite"],
  ["\u2329.sqlite", "\u3008.sqlite"],
  ["猫.sqlite", "犬.sqlite"],
  [path.join("Future", "Agent", "worker.sqlite"), path.join("future", "agent", "worker.sqlite")],
  [path.join("é", "openclaw-agent.sqlite"), path.join("e\u0301", "openclaw-agent.sqlite")],
  [path.join("a", "Foo.sqlite"), path.join("a", "foo.sqlite")],
  ["A".repeat(248) + ".sqlite", "a".repeat(248) + ".sqlite"],
])("matches direct filesystem lookup for %s / %s without retaining probes", async (left, right) => {
  const directory = await tempRoot("fs-safe-suffix-observation-");
  const expected = directObservation(directory, left, right);
  expect(probePathSuffixAliasesSync({ directory, left, right })).toBe(expected);
  expect(fs.readdirSync(directory)).toEqual([]);
});

itPosix.each([["part:É", "part:é"], ["part\\É", "part\\é"]])(
  "preserves POSIX literal component bytes %s / %s", async (left, right) => {
    const directory = await tempRoot("fs-safe-suffix-literal-");
    const expected = directObservation(directory, left, right);
    expect(probePathSuffixAliasesSync({ directory, left, right })).toBe(expected);
    expect(fs.readdirSync(directory)).toEqual([]);
  },
);

it.each(["", ".", "..", "a/../b", "a/./b", "a//b", "/absolute", "nul\0name"])(
  "rejects invalid suffix %j before mutation, including equal inputs", async (suffix) => {
    const directory = await tempRoot("fs-safe-suffix-invalid-");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    expect(() => probePathSuffixAliasesSync({ directory, left: suffix, right: suffix })).toThrow(TypeError);
    expect(mkdir).not.toHaveBeenCalled();
  },
);

itWin32.each(["C:foo", "a\\C:foo", "name:stream", "\\\\server\\share", "\\\\?\\C:\\x"])(
  "rejects Windows path-control suffix %s", async suffix => {
    const directory = await tempRoot("fs-safe-suffix-win-invalid-");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    expect(() => probePathSuffixAliasesSync({ directory, left: suffix, right: suffix })).toThrow(TypeError);
    expect(mkdir).not.toHaveBeenCalled();
  },
);

it("rejects Windows reserved components before filesystem work", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const mkdir = vi.spyOn(fs, "mkdirSync");
  // These single-component admission cases need no platform filesystem behavior.
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    for (const name of ["CON", "NUL.sqlite", "CLOCK$", "CONIN$", "COM¹", "LPT³.sqlite"]) {
      expect(() => probePathSuffixAliasesSync({ directory: ".", left: name, right: name })).toThrow(TypeError);
    }
    expect(mkdir).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

it("rejects unequal depths and NUL parent input before touching the filesystem", () => {
  const mkdir = vi.spyOn(fs, "mkdirSync");
  expect(() => probePathSuffixAliasesSync({ directory: ".", left: "a", right: path.join("a", "b") })).toThrow(TypeError);
  expect(() => probePathSuffixAliasesSync({ directory: "bad\0directory", left: "same", right: "same" })).toThrow(TypeError);
  expect(mkdir).not.toHaveBeenCalled();
});

it("keeps caller exclusions separate from actual dotted-I lookup", async () => {
  const directory = await tempRoot("fs-safe-suffix-policy-");
  const left = "İ.sqlite";
  const right = "i\u0307.sqlite";
  const expected = directObservation(directory, left, right);
  expect(probePathSuffixAliasesSync({ directory, left, right })).toBe(expected);
  const predicate = vi.fn(() => false);
  expect(probePathSuffixAliasesSync({ directory, left, right, shouldProbeCaseVariants: predicate })).toBe(false);
  expect(predicate).toHaveBeenCalledWith(left.normalize("NFC"), right.normalize("NFC"));
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("resolves an initial caller exclusion without filesystem observations", () => {
  const observe = vi.spyOn(fs, "lstatSync").mockImplementation(() => { throw new Error("unexpected filesystem read"); });
  expect(probePathSuffixAliasesSync({ directory: "unused", left: "猫", right: "犬", shouldProbeCaseVariants: () => false })).toBe(false);
  expect(observe).not.toHaveBeenCalled();
});

it("does not skip earlier uncertainty to evaluate a later policy exclusion", async () => {
  const directory = await tempRoot("fs-safe-suffix-order-");
  const predicate = vi.fn(() => false);
  vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
    throw Object.assign(new Error("cannot probe"), { code: "EACCES" });
  });
  expect(probePathSuffixAliasesSync({
    directory, left: path.join("a", "İ"), right: path.join("a", "i\u0307"),
    shouldProbeCaseVariants: predicate,
  })).toBeUndefined();
  expect(predicate).not.toHaveBeenCalled();
});

it("propagates a trusted predicate exception after cleaning earlier component probes", async () => {
  const directory = await tempRoot("fs-safe-suffix-callback-");
  const failure = new Error("caller policy failed");
  expect(() => probePathSuffixAliasesSync({
    directory, left: path.join("a", "É"), right: path.join("a", "é"),
    shouldProbeCaseVariants: () => { throw failure; },
  })).toThrow(failure);
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("rejects asynchronous predicate results without an unhandled rejection", async () => {
  const directory = await tempRoot("fs-safe-suffix-async-policy-");
  expect(() => Reflect.apply(probePathSuffixAliasesSync, undefined, [{
    directory, left: path.join("a", "É"), right: path.join("a", "é"),
    shouldProbeCaseVariants: () => Promise.reject(new Error("asynchronous policy")),
  }])).toThrow(/return a boolean synchronously/);
  await Promise.resolve();
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("returns unknown when all generated probe names already exist", async () => {
  const directory = await tempRoot("fs-safe-suffix-collisions-");
  vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
    throw Object.assign(new Error("reserved"), { code: "EEXIST" });
  });
  expect(probePathSuffixAliasesSync({ directory, left: "ABC", right: "abc" })).toBeUndefined();
  expect(fs.readdirSync(directory)).toEqual([]);
});

it.each([
  ["BB", "bB", 0],
  ["KB", "kB", 8],
] as const)("never materializes requested lookups through a generated alias (%s / %s)", async (left, right, firstByte) => {
  const directory = await tempRoot("fs-safe-suffix-forbidden-alias-");
  const expected = directObservation(directory, left, right);
  const randomBytes = crypto.randomBytes;
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomBytes")!;
  const mkdir = fs.mkdirSync;
  let injected = false;
  let requestedLookupExisted = false;
  const rootNames: string[] = [];
  Object.defineProperty(crypto, "randomBytes", { ...descriptor, value: (size: number) => {
    if (!injected && size === 2) {
      injected = true;
      return Buffer.from([firstByte, 1]);
    }
    return randomBytes(size);
  } });
  syncBuiltinESMExports();
  vi.spyOn(fs, "mkdirSync").mockImplementation((candidate, options) => {
    const result = mkdir(candidate, options);
    if (path.dirname(String(candidate)) === directory) rootNames.push(path.basename(String(candidate)));
    requestedLookupExisted ||= fs.existsSync(path.join(directory, left)) || fs.existsSync(path.join(directory, right));
    return result;
  });
  try {
    expect(probePathSuffixAliasesSync({ directory, left, right })).toBe(expected);
    expect(injected).toBe(true);
    expect(requestedLookupExisted).toBe(false);
    const forbidden = new Set([left, right].map(value => value.normalize("NFC").toLowerCase()));
    expect(rootNames.some(name => forbidden.has(name.normalize("NFC").toLowerCase()))).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    Object.defineProperty(crypto, "randomBytes", descriptor);
    syncBuiltinESMExports();
  }
});

itPosix.each(["file", "symlink"] as const)("retries an alternate-name collision with a %s", async (kind) => {
  const directory = await tempRoot("fs-safe-suffix-alternate-collision-");
  const expected = directObservation(directory, "ABC", "abc");
  const sentinel = path.join(directory, "sentinel");
  fs.writeFileSync(sentinel, "preserve");
  const collision = kind === "file" ? sentinel : path.join(directory, "sentinel-link");
  if (kind === "symlink") fs.symlinkSync(sentinel, collision);
  const mkdir = fs.mkdirSync;
  const lstat = fs.lstatSync;
  let created = "";
  let injected = false;
  vi.spyOn(fs, "mkdirSync").mockImplementation((candidate, options) => {
    const result = mkdir(candidate, options);
    created = String(candidate);
    return result;
  });
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const name = path.basename(created);
    const alternate = path.join(directory, name.charAt(0).toUpperCase() + name.slice(1));
    if (created && !injected && args[0] === alternate) {
      injected = true;
      // Use real entry metadata to model one concurrent alternate collision.
      return lstat(collision, args[1]);
    }
    return lstat(...args);
  });
  expect(probePathSuffixAliasesSync({ directory, left: "ABC", right: "abc" })).toBe(expected);
  expect(injected).toBe(true);
  expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve");
  expect(fs.readdirSync(directory).toSorted()).toEqual(kind === "file" ? ["sentinel"] : ["sentinel", "sentinel-link"]);
});

it("preserves a directory replaced after its creation observation", async () => {
  const parent = await tempRoot("fs-safe-suffix-replaced-");
  const directory = path.join(parent, "root");
  fs.mkdirSync(directory);
  const lstat = fs.lstatSync;
  let replaced = "";
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    const candidate = String(args[0]);
    if (!replaced && path.dirname(candidate) === directory) {
      replaced = candidate;
      fs.renameSync(candidate, path.join(parent, "original"));
      fs.mkdirSync(candidate);
      fs.writeFileSync(path.join(candidate, "sentinel"), "preserve");
    }
    return stat;
  });
  expect(probePathSuffixAliasesSync({ directory, left: "ABC", right: "abc" })).toBeUndefined();
  expect(replaced).not.toBe("");
  expect(fs.readFileSync(path.join(replaced, "sentinel"), "utf8")).toBe("preserve");
});

itPosix("rejects a replaced ancestor before probing through its symlink", async () => {
  const parent = await tempRoot("fs-safe-suffix-ancestor-");
  const directory = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(directory);
  fs.mkdirSync(outside);
  let replaced = "";
  expect(probePathSuffixAliasesSync({
    directory, left: path.join("a", "É"), right: path.join("a", "é"),
    shouldProbeCaseVariants: () => {
      replaced = path.join(directory, fs.readdirSync(directory)[0]!);
      fs.renameSync(replaced, path.join(parent, "original"));
      fs.symlinkSync(outside, replaced);
      return true;
    },
  })).toBeUndefined();
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.lstatSync(replaced).isSymbolicLink()).toBe(true);
});

it("preserves nonempty probes and marks the completed observation unknown", async () => {
  const directory = await tempRoot("fs-safe-suffix-nonempty-");
  const rmdir = fs.rmdirSync;
  let retained = "";
  vi.spyOn(fs, "rmdirSync").mockImplementation((candidate, options) => {
    retained = String(candidate);
    fs.writeFileSync(path.join(retained, "sentinel"), "preserve");
    return rmdir(candidate, options);
  });
  expect(probePathSuffixAliasesSync({ directory, left: "ABC", right: "abc" })).toBeUndefined();
  expect(fs.readFileSync(path.join(retained, "sentinel"), "utf8")).toBe("preserve");
});

it("does not guess cleanup ownership when initial directory identity cannot be read", async () => {
  const directory = await tempRoot("fs-safe-suffix-no-identity-");
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    if (path.dirname(String(args[0])) === directory) {
      throw Object.assign(new Error("identity unavailable"), { code: "EACCES" });
    }
    return lstat(...args);
  });
  expect(probePathSuffixAliasesSync({ directory, left: "ABC", right: "abc" })).toBeUndefined();
  expect(fs.readdirSync(directory)).toHaveLength(1);
});

it.each([
  { phase: "post-observation", failAt: 1, remaining: 0 },
  { phase: "cleanup", failAt: 2, remaining: 1 },
])("returns unknown after transient $phase ownership failure", async ({ failAt, remaining }) => {
  const parent = await tempRoot("fs-safe-suffix-cleanup-uncertain-");
  const directory = path.join(parent, "root");
  const displaced = path.join(parent, "displaced");
  fs.mkdirSync(directory);
  const native = fs.realpathSync.native;
  let policyReturned = false;
  let observationsAfterPolicy = 0;
  let interrupted = false;
  vi.spyOn(fs.realpathSync, "native").mockImplementation((...args) => {
    if (policyReturned && args[0] === directory && ++observationsAfterPolicy === failAt) {
      interrupted = true;
      fs.renameSync(directory, displaced);
      try { return native(...args); }
      finally { fs.renameSync(displaced, directory); }
    }
    return native(...args);
  });
  expect(probePathSuffixAliasesSync({
    directory, left: path.join("a", "猫"), right: path.join("a", "犬"),
    shouldProbeCaseVariants: () => { policyReturned = true; return false; },
  })).toBeUndefined();
  expect(interrupted).toBe(true);
  expect(fs.readdirSync(directory)).toHaveLength(remaining);
});

itPosix("preserves the existing parent mode", async () => {
  const directory = await tempRoot("fs-safe-suffix-mode-");
  fs.chmodSync(directory, 0o755);
  probePathSuffixAliasesSync({ directory, left: "ABC", right: "abc" });
  expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
  expect(fs.readdirSync(directory)).toEqual([]);
});
