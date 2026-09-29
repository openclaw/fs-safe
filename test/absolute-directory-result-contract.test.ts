import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAbsoluteDirectory, type EnsureAbsoluteDirectoryOptions } from "../src/absolute-path.js";
import { FsSafeError } from "../src/errors.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function settle<T>(pending: Promise<T>) {
  try { return { rejected: false as const, value: await pending }; }
  catch (error) { return { rejected: true as const, error }; }
}

const guardRoles = [
  { name: "initial acquisition", subject: "parent", occurrence: 2, created: 0 },
  { name: "pre-child inspection", subject: "parent", occurrence: 3, created: 0 },
  { name: "pre-mkdir recheck", subject: "parent", occurrence: 4, created: 0 },
  { name: "child acquisition", subject: "target", occurrence: 4, created: 1 },
  { name: "previous-parent recheck", subject: "parent", occurrence: 6, created: 1 },
  { name: "final check", subject: "target", occurrence: 5, created: 1 },
] as const;
const reinspectionKinds = ["directory", "symlink", "file", "ENOENT", "ENOTDIR"] as const;

describe("absolute-directory classified failure ownership", () => {
  for (const role of guardRoles) {
    it.each(reinspectionKinds)(`${role.name}: reinspection sees %s`, async kind => {
      const fixture = await tempRoot("fs-safe-absolute-result-");
      const outside = await tempRoot("fs-safe-absolute-outside-");
      const parent = path.join(fixture, "parent");
      const target = path.join(parent, "child");
      fsSync.mkdirSync(parent);
      const subject = role.subject === "parent" ? parent : target;
      const originalCause = Object.freeze({ source: role.name });
      const original = new FsSafeError("not-file", "guard refused", { cause: originalCause });
      const notDirectory = Object.assign(new Error("synthetic reinspection failure"), { code: "ENOTDIR" });
      const lstat = fsSync.lstatSync.bind(fsSync);
      const mkdir = fs.mkdir.bind(fs);
      let subjectReads = 0;
      let injected = false;
      let reinspectionPending = false;
      let reinspections = 0;
      let mkdirCalls = 0;
      let lookupFailure: unknown;
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        if (String(args[0]) === target) mkdirCalls += 1;
        return await mkdir(...args);
      });
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        if (String(args[0]) !== subject) return lstat(...args);
        subjectReads += 1;
        if (!injected && subjectReads === role.occurrence) {
          injected = true;
          if (kind === "symlink" || kind === "file" || kind === "ENOENT") {
            fsSync.renameSync(subject, `${subject}-retained`);
            if (kind === "symlink") fsSync.symlinkSync(outside, subject, process.platform === "win32" ? "junction" : "dir");
            if (kind === "file") fsSync.writeFileSync(subject, "replacement");
          }
          reinspectionPending = true;
          throw original;
        }
        if (reinspectionPending) {
          reinspectionPending = false;
          reinspections += 1;
          try {
            if (kind === "ENOTDIR") throw notDirectory;
            return lstat(...args);
          } catch (error) {
            lookupFailure = error;
            throw error;
          }
        }
        return lstat(...args);
      });
      const result = await ensureAbsoluteDirectory(target);
      expect(injected).toBe(true);
      expect(reinspections).toBe(1);
      expect(mkdirCalls).toBe(role.created);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("policy failure unexpectedly succeeded");
      expect(result.code).toBe(kind === "symlink" ? "symlink" : kind === "ENOENT" ? "not-found" : "not-file");
      if (kind === "directory") {
        expect(result.error).toBe(original);
        expect(result.error.cause).toBe(originalCause);
      } else if (kind === "ENOENT" || kind === "ENOTDIR") {
        expect(result.error.cause).toBe(lookupFailure);
      } else {
        expect(result.error.cause).toBeUndefined();
      }
      expect(fsSync.readdirSync(outside)).toEqual([]);
    });
  }

  for (const freeze of [false, true]) {
    it(`does not classify a caller-rethrown prior result (frozen=${freeze})`, async () => {
      const fixture = await tempRoot("fs-safe-absolute-result-reuse-");
      const file = path.join(fixture, "file");
      fsSync.writeFileSync(file, "file");
      const previous = await ensureAbsoluteDirectory(path.join(file, "child"));
      expect(previous.ok).toBe(false);
      if (freeze) Object.freeze(previous);
      let modeReads = 0;
      const target = path.join(fixture, "new");
      const caught = await settle(ensureAbsoluteDirectory(target, {
        get mode() { modeReads += 1; throw previous; },
      }));
      expect(caught.rejected).toBe(true);
      if (!caught.rejected) throw new Error("caller value was converted into a result");
      expect(caught.error === previous).toBe(true);
      expect(modeReads).toBe(1);
      expect(fsSync.existsSync(target)).toBe(false);
    });
  }

  it("keeps overlapping success, classified failures and ordinary rejections separate", async () => {
    const fixture = await tempRoot("fs-safe-absolute-result-overlap-");
    const file = path.join(fixture, "file");
    fsSync.writeFileSync(file, "file");
    const raw = new FsSafeError("not-file", "caller rejection");
    // Start the classified call first; its private propagation is still pending
    // when the two other calls enter their asynchronous prefixes.
    const pending = [
      settle(ensureAbsoluteDirectory(path.join(file, "child"))),
      settle(ensureAbsoluteDirectory(path.join(fixture, "created", "child"))),
      settle(ensureAbsoluteDirectory(path.join(fixture, "denied"), { get mode() { throw raw; } })),
    ];
    const [classified, successful, rejected] = await Promise.all(pending);
    expect(classified).toMatchObject({ rejected: false, value: { ok: false, code: "not-file" } });
    expect(successful).toEqual({ rejected: false, value: { ok: true, path: path.join(fixture, "created", "child") } });
    expect(rejected?.rejected).toBe(true);
    if (!rejected?.rejected) throw new Error("ordinary rejection was classified");
    expect(rejected.error).toBe(raw);
    expect(fsSync.existsSync(path.join(fixture, "denied"))).toBe(false);
  });
});

function thrownValue(kind: string) {
  let prototypeReads = 0;
  let codeReads = 0;
  const marker = Object.freeze({ source: "code getter" });
  let value: unknown;
  let modeOutcome: "same" | "type-error" | "marker" = "same";
  switch (kind) {
    case "Error": value = Object.assign(new Error("denied"), { code: "EACCES" }); break;
    case "FsSafeError": value = new FsSafeError("not-file", "unbranded"); break;
    case "frozen-object": value = Object.freeze({ denied: true }); break;
    case "function": value = function rejectedCallback() {}; break;
    case "string": value = "denied"; break;
    case "number": value = 7; break;
    case "boolean": value = false; break;
    case "bigint": value = 7n; break;
    case "symbol": value = Symbol("denied"); break;
    case "null": value = null; modeOutcome = "type-error"; break;
    case "undefined": value = undefined; modeOutcome = "type-error"; break;
    case "revoked-proxy": {
      const proxy = Proxy.revocable({}, {});
      proxy.revoke();
      value = proxy.proxy;
      modeOutcome = "type-error";
      break;
    }
    default:
      value = new Proxy({}, {
        get(_target, key) {
          if (key === "code") {
            codeReads += 1;
            if (kind === "throwing-code-proxy") throw marker;
          }
          return undefined;
        },
        getPrototypeOf() { prototypeReads += 1; throw new Error("prototype must not be inspected"); },
      });
      if (kind === "throwing-code-proxy") modeOutcome = "marker";
  }
  return { value, modeOutcome, marker, reads: () => ({ prototypeReads, codeReads }) };
}

const thrownKinds = ["Error", "FsSafeError", "frozen-object", "function", "string", "number", "boolean", "bigint", "symbol", "null", "undefined", "revoked-proxy", "throwing-prototype-proxy", "throwing-code-proxy"];
for (const field of ["scopeLabel", "mode"] as const) {
  it.each(thrownKinds)(`${field} getter keeps existing rejection semantics for %s`, async kind => {
    const fixture = await tempRoot("fs-safe-absolute-result-values-");
    const target = path.join(fixture, "child");
    const thrown = thrownValue(kind);
    let getterReads = 0;
    const options: EnsureAbsoluteDirectoryOptions = {};
    Object.defineProperty(options, field, { get() { getterReads += 1; throw thrown.value; } });
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const mkdir = vi.spyOn(fs, "mkdir");
    const caught = await settle(ensureAbsoluteDirectory(target, options));
    expect(caught.rejected).toBe(true);
    if (!caught.rejected) throw new Error("getter failure unexpectedly fulfilled");
    if (field === "scopeLabel" || thrown.modeOutcome === "same") {
      expect(caught.error === thrown.value).toBe(true);
    } else if (thrown.modeOutcome === "marker") {
      expect(caught.error === thrown.marker).toBe(true);
    } else {
      // Existing mkdir-error code access converts null/undefined/revoked proxies.
      expect(caught.error instanceof TypeError).toBe(true);
    }
    expect(getterReads).toBe(1);
    expect(thrown.reads()).toEqual({ prototypeReads: 0, codeReads: field === "mode" && kind.startsWith("throwing-") ? 1 : 0 });
    if (field === "scopeLabel") expect(lstat).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(fsSync.existsSync(target)).toBe(false);
  });
}

it.each(["directory", "symlink", "file", "vanished-twice"] as const)("preserves EEXIST retry and mode reads after a %s collision", async kind => {
  const fixture = await tempRoot("fs-safe-absolute-result-collision-");
  const outside = await tempRoot("fs-safe-absolute-result-collision-outside-");
  const target = path.join(fixture, "child");
  const mkdir = fs.mkdir.bind(fs);
  let attempts = 0;
  let modeReads = 0;
  const events: string[] = [];
  const options: EnsureAbsoluteDirectoryOptions = {
    get mode() { expect(this).toBe(options); modeReads += 1; events.push("mode"); return 0o700; },
  };
  vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
    if (String(args[0]) !== target) return await mkdir(...args);
    attempts += 1;
    events.push("mkdir");
    if (kind === "vanished-twice" && attempts === 3) return await mkdir(...args);
    if (kind === "symlink") fsSync.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
    else if (kind === "file") fsSync.writeFileSync(target, "collision");
    else {
      fsSync.mkdirSync(target);
      if (kind === "vanished-twice") fsSync.rmdirSync(target);
    }
    throw Object.assign(new Error("synthetic raced EEXIST"), { code: "EEXIST" });
  });
  const result = await ensureAbsoluteDirectory(target, options);
  const expectedAttempts = kind === "vanished-twice" ? 3 : 1;
  expect(modeReads).toBe(expectedAttempts);
  expect(attempts).toBe(expectedAttempts);
  expect(events).toEqual(Array.from({ length: expectedAttempts }, () => ["mode", "mkdir"]).flat());
  if (kind === "directory" || kind === "vanished-twice") expect(result).toEqual({ ok: true, path: target });
  else expect(result).toMatchObject({ ok: false, code: kind === "symlink" ? "symlink" : "not-file" });
  expect(fsSync.readdirSync(outside)).toEqual([]);
});

it("keeps guards on both sides of mkdir and reads mode after the second parent fence", async () => {
  const fixture = await tempRoot("fs-safe-absolute-result-order-");
  const parent = path.join(fixture, "parent");
  const target = path.join(parent, "child");
  fsSync.mkdirSync(parent);
  const events: string[] = [];
  const lstat = fsSync.lstatSync.bind(fsSync);
  const mkdir = fs.mkdir.bind(fs);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (String(args[0]) === parent) events.push("parent");
    if (String(args[0]) === target) events.push("target");
    return lstat(...args);
  });
  vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
    if (String(args[0]) === target) events.push("mkdir");
    return await mkdir(...args);
  });
  const options: EnsureAbsoluteDirectoryOptions = {
    get scopeLabel() { events.push("scope"); return "ordered directory"; },
    get mode() { expect(this).toBe(options); events.push("mode"); return 0o700; },
  };
  expect(await ensureAbsoluteDirectory(target, options)).toEqual({ ok: true, path: target });
  expect(events).toEqual([
    "scope", "parent", "target", "parent", "parent", "target", "parent", "mode", "mkdir",
    "parent", "target", "target", "parent", "target",
  ]);
});
