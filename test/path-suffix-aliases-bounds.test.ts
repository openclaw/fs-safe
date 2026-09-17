import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { probePathSuffixAliasesSync } from "../src/path-suffix-aliases.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

const errno = (code: string) => Object.assign(new Error(code), { code });
const suffix = (component: string, depth: number) => Array.from({ length: depth }, () => component).join(path.sep);

it.runIf(process.platform === "win32").each(["?", "."])(
  "dispatches the %s namespace drive root without mutating it", (family) => {
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw errno("EACCES"); });
    const mkdir = vi.spyOn(fs, "mkdirSync");
    expect(probePathSuffixAliasesSync({
      directory: `\\\\${family}\\C:\\`, left: "alpha", right: "ALPHA",
    })).toBeUndefined();
    expect(realpath).toHaveBeenCalledTimes(1);
    expect(realpath).toHaveBeenCalledWith("C:\\");
    expect(mkdir).not.toHaveBeenCalled();
  },
);

// This model supplies real bigint-shaped metadata with stable, nonzero identities.
// Case/normalization aliases and collisions are deterministic on every host; the
// separate real-filesystem suite checks actual platform behavior and replacement.
function countedFilesystem(directory: string, options: {
  exists?: (parentDepth: number, attempt: number) => boolean;
  collision?: (parentDepth: number, attempt: number) => boolean;
  failRemoval?: boolean;
} = {}) {
  const template = fs.lstatSync(directory, { bigint: true });
  const key = (value: string) => value.normalize("NFC").toLowerCase();
  const entries = new Map<string, { name: string; stat: fs.BigIntStats }>();
  const attemptsByParent = new Map<string, number>();
  const events: { operation: string; name: string }[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  let lastCreated = "";
  let alternateCollision = false;
  let nextIdentity = 2n;
  const stat = (ino: bigint): fs.BigIntStats => Object.assign(Object.create(Object.getPrototypeOf(template)), template, {
    dev: 1n, ino, isDirectory: () => true, isSymbolicLink: () => false,
  });
  entries.set(key(directory), { name: directory, stat: stat(1n) });
  const depth = (name: string) => name === directory ? 0 : path.relative(directory, name).split(path.sep).length;
  vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
    const name = String(candidate);
    events.push({ operation: "realpath", name });
    if (name !== directory) throw errno("ENOENT");
    return directory;
  });
  vi.spyOn(fs, "lstatSync").mockImplementation((candidate) => {
    const name = String(candidate);
    events.push({ operation: "identity", name });
    if (alternateCollision && name !== lastCreated && key(name) === key(lastCreated)) return stat(999_999n);
    const entry = entries.get(key(name));
    if (!entry) throw errno("ENOENT");
    return entry.stat;
  });
  vi.spyOn(fs, "mkdirSync").mockImplementation((candidate) => {
    const name = String(candidate);
    events.push({ operation: "mkdir", name });
    const parent = path.dirname(name);
    const attempt = (attemptsByParent.get(parent) ?? 0) + 1;
    attemptsByParent.set(parent, attempt);
    if (options.exists?.(depth(parent), attempt) || entries.has(key(name))) throw errno("EEXIST");
    if (!entries.has(key(parent))) throw errno("ENOENT");
    alternateCollision = options.collision?.(depth(parent), attempt) ?? false;
    lastCreated = name;
    entries.set(key(name), { name, stat: stat(nextIdentity++) });
    created.push(name);
    return undefined;
  });
  vi.spyOn(fs, "rmdirSync").mockImplementation((candidate) => {
    const name = String(candidate);
    events.push({ operation: "rmdir", name });
    if (options.failRemoval) throw errno("EACCES");
    const entry = entries.get(key(name));
    if (!entry || entry.name !== name || name === directory) throw errno("EPERM");
    if ([...entries.values()].some(item => path.dirname(item.name) === name)) throw errno("ENOTEMPTY");
    entries.delete(key(name));
    removed.push(name);
  });
  return {
    events, created, removed, entries,
    attempts: () => events.filter(event => event.operation === "mkdir").length,
    observations: () => events.reduce((total, event) => total + (event.operation === "identity" ? 2 : event.operation === "realpath" ? 1 : 0), 0),
    expectClean() {
      expect([...entries.values()].map(entry => entry.name)).toEqual([directory]);
      expect(removed.toSorted()).toEqual(created.toSorted());
    },
  };
}

it.each([
  { field: "left", limit: 8192 },
  { field: "right", limit: 8192 },
  { field: "directory", limit: 32768 },
] as const)("admits exact $field length $limit and rejects one extra code unit before filesystem work", ({ field, limit }) => {
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const observe = vi.spyOn(fs, "lstatSync");
  const root = path.parse(process.cwd()).root;
  const exact = field === "directory" ? root + "a".repeat(limit - root.length) : "a".repeat(limit);
  const valid = field === "directory" ? { directory: exact, left: "same", right: "same" } : { directory: ".", left: exact, right: exact };
  expect(probePathSuffixAliasesSync(valid)).toBe(true);
  expect(() => probePathSuffixAliasesSync({ ...valid, [field]: exact + "a" })).toThrow(RangeError);
  expect(mkdir).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
});

it.each([undefined, "fixed", "input-scaled"] as const)(
  "rejects an oversized supplied directory before resolution or later getters with resourceBudget %s",
  (resourceBudget) => {
    const resolve = vi.spyOn(path, "resolve");
    const laterGetter = vi.fn(() => "same");
    expect(() => probePathSuffixAliasesSync({
      directory: "a".repeat(32769),
      get resourceBudget() { laterGetter(); return resourceBudget; },
      get left() { return laterGetter(); },
      right: "same",
    })).toThrow(RangeError);
    expect(resolve).not.toHaveBeenCalled();
    expect(laterGetter).not.toHaveBeenCalled();
  },
);

it.each([undefined, "fixed", "input-scaled"] as const)(
  "rejects a directory that exceeds 32768 after cwd resolution before later getters with resourceBudget %s",
  (resourceBudget) => {
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const laterGetter = vi.fn(() => "same");
    expect(() => probePathSuffixAliasesSync({
      directory: "a".repeat(32768),
      get resourceBudget() { laterGetter(); return resourceBudget; },
      get left() { return laterGetter(); },
      right: "same",
    })).toThrow(RangeError);
    expect(laterGetter).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  },
);

it("counts suffix limits in UTF-16 code units rather than bytes or code points", () => {
  const exact = "\u{1f600}".repeat(4096);
  expect(probePathSuffixAliasesSync({ directory: ".", left: exact, right: exact })).toBe(true);
  expect(() => probePathSuffixAliasesSync({ directory: ".", left: exact + "a", right: exact + "a" })).toThrow(RangeError);
});

it.each([undefined, "fixed"] as const)("keeps the 32-component limit with resourceBudget %s", (resourceBudget) => {
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const observe = vi.spyOn(fs, "lstatSync");
  const exact = suffix("a", 32);
  expect(probePathSuffixAliasesSync({ directory: ".", left: exact, right: exact, resourceBudget })).toBe(true);
  for (const field of ["left", "right"] as const) {
    expect(() => probePathSuffixAliasesSync({ directory: ".", left: exact, right: exact, resourceBudget, [field]: suffix("a", 33) })).toThrow(RangeError);
  }
  expect(mkdir).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
});

it.each([null, "", "unbounded", 0, {}, []])("rejects invalid resourceBudget %j before equal-input return", (resourceBudget) => {
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const observe = vi.spyOn(fs, "lstatSync");
  expect(() => Reflect.apply(probePathSuffixAliasesSync, undefined, [{
    directory: ".", left: "same", right: "same", resourceBudget,
  }])).toThrow(TypeError);
  expect(mkdir).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
});

it("admits input-sized suffixes without applying the fixed suffix caps", () => {
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const observe = vi.spyOn(fs, "lstatSync");
  const longSuffix = suffix("a", 20_000);
  expect(probePathSuffixAliasesSync({
    directory: ".", left: longSuffix, right: longSuffix, resourceBudget: "input-scaled",
  })).toBe(true);
  expect(mkdir).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
});

it("bounds very large segment lists without an arbitrary-spread or call-stack failure", () => {
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const input = suffix("a", 200_000);
  let caught: unknown;
  try { probePathSuffixAliasesSync({ directory: ".", left: input, right: input }); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(RangeError);
  expect(String(caught)).not.toMatch(/call stack|too many arguments/i);
  expect(mkdir).not.toHaveBeenCalled();
});

it.each(["resource-budget", "left", "right", "predicate-getter", "predicate"])(
  "reads each option once and snapshots relative directory before a %s cwd change", async (changeAt) => {
    const directory = await tempRoot("fs-safe-suffix-snapshot-");
    const other = await tempRoot("fs-safe-suffix-other-cwd-");
    const previous = process.cwd();
    const reads: string[] = [];
    const read = (name: string) => {
      if (reads.includes(name)) throw new Error(`option reread: ${name}`);
      reads.push(name);
      if (changeAt === name) process.chdir(other);
    };
    const mkdir = fs.mkdirSync;
    const mutations: string[] = [];
    vi.spyOn(fs, "mkdirSync").mockImplementation((candidate, options) => {
      mutations.push(String(candidate));
      return mkdir(candidate, options);
    });
    try {
      process.chdir(directory);
      const result = probePathSuffixAliasesSync({
        get directory() { read("directory"); return "."; },
        get resourceBudget() { read("resource-budget"); return changeAt === "resource-budget" ? "input-scaled" : undefined; },
        get left() { read("left"); return "猫"; },
        get right() { read("right"); return "犬"; },
        get shouldProbeCaseVariants() {
          read("predicate-getter");
          return () => { if (changeAt === "predicate") process.chdir(other); return true; };
        },
      });
      expect(result).toBe(false);
      expect(reads).toEqual(["directory", "resource-budget", "left", "right", "predicate-getter"]);
      expect(mutations.length).toBeGreaterThan(0);
      expect(mutations.every(name => {
        const relative = path.relative(directory, name);
        return relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== ".." && path.isAbsolute(name);
      })).toBe(true);
      expect(fs.readdirSync(directory)).toEqual([]);
      expect(fs.readdirSync(other)).toEqual([]);
    } finally { process.chdir(previous); }
  },
);

it("validates directory before evaluating later option getters", () => {
  const left = vi.fn(() => "same");
  for (const directory of ["bad\0directory", "a".repeat(32769)]) {
    expect(() => probePathSuffixAliasesSync({ directory, get left() { return left(); }, right: "same" })).toThrow();
  }
  expect(left).not.toHaveBeenCalled();
});

it("does not reread values mutated by the trusted predicate", async () => {
  const directory = await tempRoot("fs-safe-suffix-mutated-options-");
  const options = {
    directory, left: "猫", right: "犬",
    shouldProbeCaseVariants: () => {
      options.directory = "bad\0directory";
      options.left = "..";
      options.right = "..";
      return true;
    },
  };
  expect(probePathSuffixAliasesSync(options)).toBe(false);
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("counts EEXIST against the 128 mkdir-attempt ceiling and cleans every owned probe", async () => {
  const directory = await tempRoot("fs-safe-suffix-attempt-budget-");
  const model = countedFilesystem(directory, { exists: (_depth, attempt) => attempt % 24 !== 0 });
  expect(probePathSuffixAliasesSync({ directory, left: suffix("ABC", 6), right: suffix("abc", 6) })).toBeUndefined();
  expect(model.attempts()).toBe(128);
  expect(model.created).toHaveLength(5);
  model.expectClean();
});

it("allows the final successful mkdir at exactly 128 attempts", async () => {
  const directory = await tempRoot("fs-safe-suffix-attempt-boundary-");
  const model = countedFilesystem(directory, { exists: (parentDepth, attempt) => attempt !== (parentDepth === 5 ? 8 : 24) });
  expect(probePathSuffixAliasesSync({ directory, left: suffix("ABC", 6), right: suffix("abc", 6) })).toBe(true);
  expect(model.attempts()).toBe(128);
  expect(model.created).toHaveLength(6);
  model.expectClean();
});

it("counts removed alternate collisions against the 64-successful-creation ceiling", async () => {
  const directory = await tempRoot("fs-safe-suffix-creation-budget-");
  const model = countedFilesystem(directory, { collision: (_depth, attempt) => attempt % 24 !== 0 });
  expect(probePathSuffixAliasesSync({ directory, left: suffix("ABC", 3), right: suffix("abc", 3) })).toBeUndefined();
  expect(model.created).toHaveLength(64);
  expect(model.attempts()).toBe(64);
  expect(model.observations()).toBeLessThan(4096);
  model.expectClean();
});

it("allows a final successful observation at exactly 64 creations", async () => {
  const directory = await tempRoot("fs-safe-suffix-creation-boundary-");
  const model = countedFilesystem(directory, { collision: (parentDepth, attempt) => attempt !== (parentDepth === 2 ? 16 : 24) });
  expect(probePathSuffixAliasesSync({ directory, left: suffix("ABC", 3), right: suffix("abc", 3) })).toBe(true);
  expect(model.created).toHaveLength(64);
  expect(model.attempts()).toBe(64);
  model.expectClean();
});

it("allows a complete 32-component first-success chain within the observation budget", async () => {
  const directory = await tempRoot("fs-safe-suffix-depth-budget-");
  const model = countedFilesystem(directory);
  expect(probePathSuffixAliasesSync({ directory, left: suffix("ABC", 32), right: suffix("abc", 32) })).toBe(true);
  expect(model.created).toHaveLength(32);
  expect(model.attempts()).toBe(32);
  // 3529 conservative forward units plus 1155 cleanup units; cleanup is not
  // charged against the 4096 forward allowance and must finish in full.
  expect(model.observations()).toBe(4684);
  model.expectClean();
});

it("scales all operation budgets for deep probes with repeated alternate collisions", async () => {
  const directory = await tempRoot("fs-safe-suffix-scaled-collisions-");
  const model = countedFilesystem(directory, { collision: (_depth, attempt) => attempt % 24 !== 0 });
  expect(probePathSuffixAliasesSync({
    directory, left: suffix("ABC", 33), right: suffix("abc", 33), resourceBudget: "input-scaled",
  })).toBe(true);
  expect(model.created.length).toBeGreaterThan(64);
  expect(model.attempts()).toBeGreaterThan(128);
  expect(model.observations()).toBeGreaterThan(4096);
  model.expectClean();
});

it("budgets deep generated paths from the longer spelling at every level", async () => {
  const directory = await tempRoot("fs-safe-suffix-scaled-alternating-lengths-");
  const model = countedFilesystem(directory);
  const decomposed = "A\u0301".repeat(64);
  const composed = "\u00c1".repeat(64);
  const left = Array.from({ length: 34 }, (_, index) => index % 2 === 0 ? decomposed : composed)
    .join(path.sep);
  const right = Array.from({ length: 34 }, (_, index) => index % 2 === 0 ? composed : decomposed)
    .join(path.sep);
  expect(probePathSuffixAliasesSync({
    directory, left, right, resourceBudget: "input-scaled",
  })).toBe(true);
  expect(model.created).toHaveLength(68);
  const finalAlternate = model.events.filter(({ operation, name }) =>
    operation === "identity" && name !== directory && !model.created.includes(name)).at(-1);
  expect(finalAlternate?.name.length - directory.length).toBe(3_600);
  // A max-of-whole-suffixes mutant admits only 3,569 code units and rejects this path.
  model.expectClean();
});

it("cleans the owned deep chain when input-scaled candidate retries are exhausted", async () => {
  const directory = await tempRoot("fs-safe-suffix-scaled-exhausted-");
  const model = countedFilesystem(directory, { exists: (parentDepth) => parentDepth === 32 });
  expect(probePathSuffixAliasesSync({
    directory, left: suffix("ABC", 34), right: suffix("abc", 34), resourceBudget: "input-scaled",
  })).toBeUndefined();
  expect(model.created).toHaveLength(32);
  model.expectClean();
});

it("exhausts the 4096 forward-observation allowance before mkdir/creation limits and still cleans", async () => {
  const directory = await tempRoot("fs-safe-suffix-observation-budget-");
  const model = countedFilesystem(directory, {
    exists: (parentDepth, attempt) => parentDepth === 31 || (parentDepth === 0 && attempt === 1),
  });
  expect(probePathSuffixAliasesSync({ directory, left: suffix("ABC", 32), right: suffix("abc", 32) })).toBeUndefined();
  expect(model.created).toHaveLength(31);
  expect(model.attempts()).toBe(43);
  // Initial-admission capacity is reserved before mkdir but charged only on
  // success. One root EEXIST plus eleven deep EEXIST attempts leave a partial
  // parent guard that reaches exactly 4096 units before a forty-fourth mkdir.
  // Cleaning 31 owned levels plus the final root guard costs 1088 more units.
  expect(model.observations()).toBe(4096 + 1088);
  model.expectClean();
});

it("stops immediately after failed collision removal, then attempts owned cleanup", async () => {
  const directory = await tempRoot("fs-safe-suffix-collision-cleanup-");
  const model = countedFilesystem(directory, { collision: () => true, failRemoval: true });
  expect(probePathSuffixAliasesSync({ directory, left: "ABC", right: "abc" })).toBeUndefined();
  expect(model.attempts()).toBe(1);
  expect(model.created).toHaveLength(1);
  expect(model.events.filter(event => event.operation === "rmdir").map(event => event.name)).toEqual([
    model.created[0], model.created[0],
  ]);
  expect(model.entries.size).toBe(2);
});

it("reserves admission observation capacity before mkdir rather than leaking an unobserved creation", async () => {
  const directory = await tempRoot("fs-safe-suffix-admission-budget-");
  const model = countedFilesystem(directory, {
    exists: (parentDepth, attempt) => (parentDepth === 0 && attempt < 20) || (parentDepth === 31 && attempt <= 10),
  });
  expect(probePathSuffixAliasesSync({ directory, left: suffix("ABC", 32), right: suffix("abc", 32) })).toBeUndefined();
  // The next mkdir would succeed, but its completed parent assertion leaves
  // only one unit: the two-unit initial identity admission cannot be reserved.
  expect(model.attempts()).toBe(60);
  expect(model.created).toHaveLength(31);
  expect(model.observations()).toBe(4095 + 1088);
  model.expectClean();
});

it.each([undefined, null, 0, "trusted failure", Symbol("trusted failure"), new Error("trusted failure")])(
  "preserves thrown trusted value %s over cleanup failure", async (failure) => {
    const directory = await tempRoot("fs-safe-suffix-thrown-value-");
    const model = countedFilesystem(directory, { failRemoval: true });
    let caught = false;
    try {
      probePathSuffixAliasesSync({
        directory, left: path.join("a", "猫"), right: path.join("a", "犬"),
        shouldProbeCaseVariants: () => { throw failure; },
      });
    } catch (error) { caught = true; expect(error).toBe(failure); }
    expect(caught).toBe(true);
    expect(model.created).toHaveLength(1);
    expect(model.events.some(event => event.operation === "rmdir")).toBe(true);
  },
);

it.each([undefined, null, 0, 1, "false", {}, () => false])(
  "rejects nonboolean predicate result %s even when cleanup fails", async (result) => {
    const directory = await tempRoot("fs-safe-suffix-nonboolean-");
    const model = countedFilesystem(directory, { failRemoval: true });
    expect(() => Reflect.apply(probePathSuffixAliasesSync, undefined, [{
      directory, left: path.join("a", "猫"), right: path.join("a", "犬"),
      shouldProbeCaseVariants: () => result,
    }])).toThrow(/return a boolean synchronously/);
    expect(model.created).toHaveLength(1);
    expect(model.events.some(event => event.operation === "rmdir")).toBe(true);
  },
);

it("rejects an asynchronous predicate result and observes its rejection despite cleanup failure", async () => {
  const directory = await tempRoot("fs-safe-suffix-async-cleanup-");
  const model = countedFilesystem(directory, { failRemoval: true });
  expect(() => Reflect.apply(probePathSuffixAliasesSync, undefined, [{
    directory, left: path.join("a", "猫"), right: path.join("a", "犬"),
    shouldProbeCaseVariants: () => Promise.reject(new Error("async rejection")),
  }])).toThrow(/return a boolean synchronously/);
  await Promise.resolve();
  expect(model.created).toHaveLength(1);
  expect(model.events.some(event => event.operation === "rmdir")).toBe(true);
});

it("rejects all-dot/space Windows components and device/path controls before observations", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const mkdir = vi.spyOn(fs, "mkdirSync");
  const observe = vi.spyOn(fs, "lstatSync");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    // Single components do not depend on the host path separator/parser. The
    // real Windows suite separately covers roots, namespaces and nested forms.
    for (const name of [" ", "...", ". ", " . .", "CON ", "NUL .txt", "aux.txt", "COM¹", "LPT³.x", "C:foo", "a:b"]) {
      expect(() => probePathSuffixAliasesSync({ directory: ".", left: name, right: name })).toThrow(TypeError);
    }
    expect(mkdir).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
