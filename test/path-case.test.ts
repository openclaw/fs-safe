import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probePathCaseInsensitiveSync } from "../src/advanced.js";
import { __cleanupRegisteredTempPathForTest } from "../src/temp-cleanup.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

function observedCaseBehavior(directory: string): boolean {
  const file = path.join(directory, "CaseControl");
  fs.writeFileSync(file, "control", { flag: "wx" });
  try {
    return fs.existsSync(path.join(directory, "cASEcONTROL"));
  } finally {
    fs.unlinkSync(file);
  }
}

describe("path-local case observations", () => {
  it.each(["file", "directory"] as const)("observes an existing %s in its parent without mutation", async kind => {
    const directory = await tempRoot("fs-safe-case-existing-");
    const file = path.join(directory, "CaseEntry");
    if (kind === "file") fs.writeFileSync(file, "unchanged", { mode: 0o640 });
    else fs.mkdirSync(file);
    const expected = fs.existsSync(path.join(directory, "cASEeNTRY"));
    const before = fs.statSync(file, { bigint: true });

    expect(probePathCaseInsensitiveSync(file, { allowTemporaryProbe: false })).toBe(expected);
    expect(fs.readdirSync(directory)).toEqual(["CaseEntry"]);
    if (kind === "file") expect(fs.readFileSync(file, "utf8")).toBe("unchanged");
    else expect(fs.readdirSync(file)).toEqual([]);
    expect(fs.statSync(file, { bigint: true })).toMatchObject({
      dev: before.dev, ino: before.ino, mode: before.mode, mtimeNs: before.mtimeNs,
    });
  });

  it("leaves an empty nearest ancestor untouched in read-only mode", async () => {
    const directory = await tempRoot("fs-safe-case-readonly-");
    const before = fs.statSync(directory, { bigint: true });
    const create = vi.spyOn(fs, "writeFileSync");

    expect(probePathCaseInsensitiveSync(path.join(directory, "missing", "leaf"), {
      allowTemporaryProbe: false,
    })).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fs.statSync(directory, { bigint: true })).toMatchObject({
      dev: before.dev, ino: before.ino, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs,
    });
  });

  it("cleans an empty probe without creating missing target directories", async () => {
    const directory = await tempRoot("fs-safe-case-temporary-");
    const observed = probePathCaseInsensitiveSync(path.join(directory, "missing", "leaf"));

    expect(fs.readdirSync(directory)).toEqual([]);
    expect(observed).toBe(observedCaseBehavior(directory));
  });

  itPosix("observes a dangling final symlink in its own parent", async () => {
    const directory = await tempRoot("fs-safe-case-link-");
    const file = path.join(directory, "CaseLink");
    fs.symlinkSync(path.join(directory, "absent", "target"), file);

    expect(probePathCaseInsensitiveSync(file, { allowTemporaryProbe: false }))
      .toBe(observedCaseBehavior(directory));
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(directory)).toEqual(["CaseLink"]);
  });

  it("does not confuse separately named hardlinks with case aliases", async context => {
    const directory = await tempRoot("fs-safe-case-hardlinks-");
    const file = path.join(directory, "CaseEntry");
    const alternate = path.join(directory, "cASEeNTRY");
    fs.writeFileSync(file, "shared");
    if (fs.existsSync(alternate)) context.skip("fixture filesystem folds ASCII case");
    fs.linkSync(file, alternate);

    expect(probePathCaseInsensitiveSync(file, { allowTemporaryProbe: false })).toBe(false);
    expect(fs.statSync(file).ino).toBe(fs.statSync(alternate).ino);
    expect(fs.readdirSync(directory).sort()).toEqual(["CaseEntry", "cASEeNTRY"].sort());
  });

  it("recognizes a case-distinct hardlink created after the first listing", async context => {
    const directory = await tempRoot("fs-safe-case-new-hardlink-");
    const file = path.join(directory, "CaseEntry");
    const alternate = path.join(directory, "cASEeNTRY");
    fs.writeFileSync(file, "shared");
    if (fs.existsSync(alternate)) context.skip("fixture filesystem folds ASCII case");
    const namesFs: { readdirSync: (directory: fs.PathLike) => string[] } = fs;
    const readNames = namesFs.readdirSync.bind(fs);
    let linked = false;
    vi.spyOn(namesFs, "readdirSync").mockImplementation(requested => {
      const names = readNames(requested);
      if (String(requested) === directory && !linked) {
        linked = true;
        fs.linkSync(file, alternate);
      }
      return names;
    });

    expect(probePathCaseInsensitiveSync(file, { allowTemporaryProbe: false })).toBe(false);
    expect(linked).toBe(true);
    expect(fs.statSync(file).ino).toBe(fs.statSync(alternate).ino);
    expect(fs.readFileSync(alternate, "utf8")).toBe("shared");
  });

  it.each(["removed", "replaced"] as const)("returns unknown when the original is %s during alternate lookup", async change => {
    const directory = await tempRoot("fs-safe-case-changing-");
    const file = path.join(directory, "CaseEntry");
    const alternate = path.join(directory, "cASEeNTRY");
    fs.writeFileSync(file, "original");
    const lstat = fs.lstatSync.bind(fs);
    let changed = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) !== alternate || changed) return lstat(...args);
      try {
        return lstat(...args);
      } finally {
        changed = true;
        fs.renameSync(file, path.join(directory, "saved"));
        if (change === "replaced") fs.writeFileSync(file, "replacement");
      }
    });

    expect(probePathCaseInsensitiveSync(file, { allowTemporaryProbe: false })).toBeUndefined();
    expect(changed).toBe(true);
    expect(fs.readFileSync(path.join(directory, "saved"), "utf8")).toBe("original");
    if (change === "replaced") expect(fs.readFileSync(file, "utf8")).toBe("replacement");
  });

  it("compares wide bigint identities without rounding them together", async () => {
    const directory = await tempRoot("fs-safe-case-wide-identity-");
    const file = path.join(directory, "CaseEntry");
    const alternate = path.join(directory, "cASEeNTRY");
    fs.writeFileSync(file, "original");
    const lstat = fs.lstatSync.bind(fs);
    const first = 9007199254740992n;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const requested = String(args[0]);
      if (requested !== file && requested !== alternate) return lstat(...args);
      const stat = lstat(file, { bigint: true });
      return Object.assign(Object.create(stat), { ino: first + (requested === alternate ? 1n : 0n) });
    });

    expect(Number(first)).toBe(Number(first + 1n));
    expect(probePathCaseInsensitiveSync(file, { allowTemporaryProbe: false })).toBe(false);
  });

  it.each(["removed", "stale alias"] as const)("does not treat %s listed variants as proof of sensitivity", async change => {
    const directory = await tempRoot("fs-safe-case-stale-listing-");
    const file = path.join(directory, "CaseEntry");
    fs.writeFileSync(file, "original");
    const namesFs: { readdirSync: (directory: fs.PathLike) => string[] } = fs;
    const readNames = namesFs.readdirSync.bind(fs);
    let reported = false;
    vi.spyOn(namesFs, "readdirSync").mockImplementation(requested => {
      const names = readNames(requested);
      if (String(requested) !== directory || reported) return names;
      reported = true;
      if (change === "removed") fs.renameSync(file, path.join(directory, "saved"));
      // Directory enumeration can race a case-only rename before entry inspection.
      return ["CaseEntry", "cASEeNTRY"];
    });

    expect(probePathCaseInsensitiveSync(file, { allowTemporaryProbe: false })).toBeUndefined();
    expect(reported).toBe(true);
    expect(fs.readFileSync(change === "removed" ? path.join(directory, "saved") : file, "utf8"))
      .toBe("original");
  });

  it("invalidates the observation when its parent alias is rebound", async () => {
    const base = await tempRoot("fs-safe-case-parent-alias-");
    const first = path.join(base, "first");
    const second = path.join(base, "second");
    const alias = path.join(base, "alias");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "CaseEntry"), "original");
    fs.writeFileSync(path.join(second, "CaseEntry"), "replacement");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(first, alias, linkType);
    const lstat = fs.lstatSync.bind(fs);
    let rebound = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) !== path.join(first, "cASEeNTRY") || rebound) return lstat(...args);
      try {
        return lstat(...args);
      } finally {
        rebound = true;
        fs.unlinkSync(alias);
        fs.symlinkSync(second, alias, linkType);
      }
    });

    expect(probePathCaseInsensitiveSync(path.join(alias, "CaseEntry"), {
      allowTemporaryProbe: false,
    })).toBeUndefined();
    expect(rebound).toBe(true);
    expect(fs.readFileSync(path.join(alias, "CaseEntry"), "utf8")).toBe("replacement");
    expect(fs.readFileSync(path.join(first, "CaseEntry"), "utf8")).toBe("original");
  });

  it("keeps an unavailable Windows identity unknown", async () => {
    const directory = await tempRoot("fs-safe-case-unknown-identity-");
    const file = path.join(directory, "CaseEntry");
    fs.writeFileSync(file, "original");
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (String(args[0]) !== file || typeof stat.ino !== "bigint") return stat;
      return Object.assign(Object.create(stat), { ino: 0n });
    });

    expect(probePathCaseInsensitiveSync(file, { allowTemporaryProbe: false })).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual(["CaseEntry"]);
  });

  it("preserves a replacement at the temporary name and invalidates its observation", async () => {
    const directory = await tempRoot("fs-safe-case-substitution-");
    const readdir = fs.readdirSync.bind(fs);
    let replacement: string | undefined;
    vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
      const entries = readdir(...args);
      if (String(args[0]) === directory && !replacement) {
        const name = entries.find(entry => typeof entry === "string" && entry.startsWith(".fs-safe-case-probe-"));
        if (typeof name === "string") {
          replacement = path.join(directory, name);
          fs.renameSync(replacement, path.join(directory, "saved-probe"));
          fs.writeFileSync(replacement, "preserve replacement");
        }
      }
      return entries;
    });

    expect(probePathCaseInsensitiveSync(path.join(directory, "missing"))).toBeUndefined();
    expect(replacement).toBeDefined();
    expect(fs.readFileSync(replacement!, "utf8")).toBe("preserve replacement");
    expect(fs.readFileSync(path.join(directory, "saved-probe"))).toHaveLength(0);
  });

  it("returns unknown on cleanup failure while retaining the existing owner's retry", async () => {
    const directory = await tempRoot("fs-safe-case-cleanup-failure-");
    const unlink = fs.unlinkSync.bind(fs);
    const failure = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (path.basename(String(file)).startsWith(".fs-safe-case-probe-")) throw failure;
      unlink(file);
    });

    expect(probePathCaseInsensitiveSync(path.join(directory, "missing"))).toBeUndefined();
    const entries = fs.readdirSync(directory);
    expect(entries).toHaveLength(1);
    spy.mockRestore();
    __cleanupRegisteredTempPathForTest(path.join(directory, entries[0]!));
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
