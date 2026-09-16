import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePathPrefixSync } from "../src/advanced.js";
import { realpathSync } from "../src/realpath.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot, tempDirs } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());
const directoryLink = process.platform === "win32" ? "junction" : "dir";

describe("resolvePathPrefixSync", () => {
  itWin32("resolves namespace drive roots and their immediately missing children", async ({ skip }) => {
    const directory = await tempRoot("fs-safe-prefix-namespace-root-");
    const driveRoot = path.parse(directory).root;
    if (!/^[A-Za-z]:[\\/]$/u.test(driveRoot)) skip();
    const existingPath = realpathSync.native(driveRoot);
    const missing = `.fs-safe-prefix-missing-${randomUUID()}`;
    expect(fs.existsSync(path.join(driveRoot, missing))).toBe(false);
    for (const family of ["?", "."]) {
      const namespaceRoot = `\\\\${family}\\${driveRoot}`;
      expect(resolvePathPrefixSync(namespaceRoot)).toEqual({
        absolutePath: namespaceRoot, existingPath, unresolvedSegments: [],
      });
      const input = `${namespaceRoot}${missing}\\child`;
      expect(resolvePathPrefixSync(input)).toEqual({
        absolutePath: input, existingPath, unresolvedSegments: [missing, "child"],
      });
    }
  });

  it("returns canonical existing files and directories without an unresolved suffix", async () => {
    const directory = await tempRoot("fs-safe-prefix-existing-");
    const file = path.join(directory, "file");
    fs.writeFileSync(file, "kept");
    for (const input of [directory, file, path.parse(directory).root]) {
      expect(resolvePathPrefixSync(input)).toEqual({
        absolutePath: input, existingPath: realpathSync.native(input), unresolvedSegments: [],
      });
    }
  });

  it.each(["future", "future/../live", "future/./tail/", "future//tail"])(
    "stops at the first missing component in %s without normalizing the suffix",
    async suffix => {
      const directory = await tempRoot("fs-safe-prefix-missing-");
      fs.writeFileSync(path.join(directory, "live"), "kept");
      const segments = suffix.split("/");
      const input = `${directory}${path.sep}${segments.join(path.sep)}`;
      expect(resolvePathPrefixSync(input)).toEqual({
        absolutePath: input, existingPath: directory, unresolvedSegments: segments,
      });
      expect(fs.readdirSync(directory)).toEqual(["live"]);
    },
  );

  it("preserves every raw token after a consumed existing prefix", async () => {
    const directory = await tempRoot("fs-safe-prefix-cursor-suffix-");
    const existing = path.join(directory, "existing", "nested");
    fs.mkdirSync(existing, { recursive: true });
    const input = `${existing}${path.sep}missing${path.sep}${path.sep}.${path.sep}..${path.sep}`;
    expect(resolvePathPrefixSync(input)).toEqual({
      absolutePath: input,
      existingPath: existing,
      unresolvedSegments: ["missing", "", ".", "..", ""],
    });
  });

  it.each(["absolute", "relative"])("resolves %s link/.. from the physical target", async form => {
    const rawDirectory = form === "relative"
      ? fs.mkdtempSync(path.join(process.cwd(), ".fs-safe-prefix-parent-"))
      : await tempRoot("fs-safe-prefix-parent-");
    if (form === "relative") tempDirs.push(rawDirectory);
    const directory = realpathSync.native(rawDirectory);
    fs.mkdirSync(path.join(directory, "deep", "dir"), { recursive: true });
    fs.symlinkSync(path.join(directory, "deep", "dir"), path.join(directory, "link"), directoryLink);
    const prefix = form === "relative" ? path.relative(process.cwd(), rawDirectory) : directory;
    expect(path.isAbsolute(prefix)).toBe(form === "absolute");
    const input = `${prefix}${path.sep}link${path.sep}..${path.sep}future`;
    const result = resolvePathPrefixSync(input);
    expect(result.existingPath).toBe(path.join(directory, "deep"));
    expect(result.unresolvedSegments).toEqual(["future"]);
    expect(result.absolutePath).toBe(form === "absolute" ? input : `${process.cwd()}${path.sep}${input}`);
  });

  it.each([false, true])("expands a dangling directory alias (child=%s)", async child => {
    const directory = await tempRoot("fs-safe-prefix-dangling-");
    const alias = path.join(directory, "alias");
    fs.symlinkSync(path.join(directory, "future"), alias, directoryLink);
    const input = child ? `${alias}${path.sep}child` : alias;
    expect(resolvePathPrefixSync(input)).toEqual({
      absolutePath: input, existingPath: directory, unresolvedSegments: child ? ["future", "child"] : ["future"],
    });
  });

  itPosix.each(["inner/../future", "missing/../live"])("retains raw symlink target %s", async target => {
    const directory = await tempRoot("fs-safe-prefix-target-");
    fs.mkdirSync(path.join(directory, "deep", "dir"), { recursive: true });
    fs.symlinkSync("deep/dir", path.join(directory, "inner"));
    fs.writeFileSync(path.join(directory, "live"), "kept");
    fs.symlinkSync(target, path.join(directory, "alias"));
    expect(resolvePathPrefixSync(path.join(directory, "alias"))).toEqual({
      absolutePath: path.join(directory, "alias"),
      existingPath: target.startsWith("inner") ? path.join(directory, "deep") : directory,
      unresolvedSegments: target.startsWith("inner") ? ["future"] : ["missing", "..", "live"],
    });
  });

  itPosix("orders a missing symlink-target suffix before the caller suffix", async () => {
    const directory = await tempRoot("fs-safe-prefix-cursor-link-");
    fs.mkdirSync(path.join(directory, "existing"));
    const alias = path.join(directory, "alias");
    fs.symlinkSync("existing/missing//target", alias);
    const input = `${alias}${path.sep}caller${path.sep}${path.sep}tail${path.sep}`;
    expect(resolvePathPrefixSync(input)).toEqual({
      absolutePath: input,
      existingPath: path.join(directory, "existing"),
      unresolvedSegments: ["missing", "", "target", "caller", "", "tail", ""],
    });
  });

  it("allows a repeated symlink with a different remaining suffix", async () => {
    const directory = await tempRoot("fs-safe-prefix-repeated-");
    fs.symlinkSync(directory, path.join(directory, "again"), directoryLink);
    const input = `${directory}${path.sep}again${path.sep}again${path.sep}future`;
    expect(resolvePathPrefixSync(input)).toMatchObject({ existingPath: directory, unresolvedSegments: ["future"] });
  });

  it("distinguishes replacement link identities above Number precision", async () => {
    const directory = await tempRoot("fs-safe-prefix-bigint-");
    const alias = path.join(directory, "alias");
    fs.symlinkSync(directory, alias, directoryLink);
    const lstat = fs.lstatSync.bind(fs);
    let inode = 2n ** 53n;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      return String(args[0]) === alias ? Object.assign(Object.create(stat), { ino: inode++ }) : stat;
    });
    const readlink = fs.readlinkSync.bind(fs);
    let expanded = false;
    vi.spyOn(fs, "readlinkSync").mockImplementation((...args) => {
      if (String(args[0]) !== alias) return readlink(...args);
      const target = expanded ? "future" : "alias";
      expanded = true;
      return target;
    });
    expect(resolvePathPrefixSync(alias)).toMatchObject({ existingPath: directory, unresolvedSegments: ["future"] });
  });

  itPosix.each(["self", "pair", "growing"])("rejects a %s symlink cycle", async shape => {
    const directory = await tempRoot("fs-safe-prefix-cycle-");
    const alias = path.join(directory, "alias");
    fs.symlinkSync(shape === "pair" ? "other" : shape === "growing" ? "alias/tail" : "alias", alias);
    if (shape === "pair") fs.symlinkSync("alias", path.join(directory, "other"));
    expect(() => resolvePathPrefixSync(alias)).toThrow(expect.objectContaining({ code: "ELOOP" }));
  });

  it("limits otherwise finite resolution to 64 symlink hops", async () => {
    const directory = await tempRoot("fs-safe-prefix-hop-limit-");
    fs.symlinkSync(directory, path.join(directory, "again"), directoryLink);
    const prefix = `${directory}${path.sep}${Array(64).fill("again").join(path.sep)}`;
    expect(resolvePathPrefixSync(`${prefix}${path.sep}future`)).toMatchObject({
      existingPath: directory, unresolvedSegments: ["future"],
    });
    expect(() => resolvePathPrefixSync(`${prefix}${path.sep}again${path.sep}future`))
      .toThrow(expect.objectContaining({ code: "ELOOP" }));
  });

  it.each(["/child", "/..", "/.", "/"])("rejects a non-directory followed by %s", async suffix => {
    const directory = await tempRoot("fs-safe-prefix-notdir-");
    const file = path.join(directory, "file");
    fs.writeFileSync(file, "kept");
    expect(() => resolvePathPrefixSync(`${file}${suffix.replaceAll("/", path.sep)}`))
      .toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  });

  itPosix("rejects a non-directory traversed within a raw symlink target", async () => {
    const directory = await tempRoot("fs-safe-prefix-link-notdir-");
    fs.writeFileSync(path.join(directory, "file"), "kept");
    fs.symlinkSync("file/../future", path.join(directory, "alias"));
    expect(() => resolvePathPrefixSync(path.join(directory, "alias")))
      .toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  });

  itPosix.skipIf(process.getuid?.() === 0).each(["/.", "/..", "/../live", "/../future", "//../live", "/./.."])(
    "requires directory search permission for raw traversal %s",
    async suffix => {
      const directory = await tempRoot("fs-safe-prefix-denied-traversal-");
      const blocked = path.join(directory, "blocked");
      const alias = path.join(directory, "alias");
      fs.mkdirSync(blocked);
      fs.symlinkSync(`blocked${suffix}`, alias);
      fs.writeFileSync(path.join(directory, "live"), "kept");
      fs.chmodSync(blocked, 0o000);
      try {
        expect(fs.lstatSync(blocked).isDirectory()).toBe(true);
        for (const input of [`${blocked}${suffix}`, alias]) {
          expect(() => fs.statSync(input)).toThrow(expect.objectContaining({ code: "EACCES" }));
          expect(() => resolvePathPrefixSync(input)).toThrow(expect.objectContaining({ code: "EACCES" }));
        }
      } finally {
        fs.chmodSync(blocked, 0o700);
      }
    },
  );

  itPosix.skipIf(process.getuid?.() === 0).each(["/", "//", "///"])(
    "keeps the filesystem's trailing-separator behavior for %s",
    async suffix => {
      const directory = await tempRoot("fs-safe-prefix-denied-separator-");
      const blocked = path.join(directory, "blocked");
      fs.mkdirSync(blocked);
      fs.chmodSync(blocked, 0o000);
      try {
        const input = `${blocked}${suffix}`;
        expect(fs.statSync(input).isDirectory()).toBe(true);
        expect(resolvePathPrefixSync(input)).toEqual({
          absolutePath: input, existingPath: blocked, unresolvedSegments: [],
        });
      } finally {
        fs.chmodSync(blocked, 0o700);
      }
    },
  );

  itPosix.skipIf(process.getuid?.() === 0)("permits dot traversal with search-only directory access", async () => {
    const directory = await tempRoot("fs-safe-prefix-search-only-");
    const searchOnly = path.join(directory, "search");
    const live = path.join(directory, "live");
    fs.mkdirSync(searchOnly);
    fs.writeFileSync(live, "kept");
    fs.chmodSync(searchOnly, 0o100);
    try {
      expect(() => fs.readdirSync(searchOnly)).toThrow(expect.objectContaining({ code: "EACCES" }));
      expect(resolvePathPrefixSync(`${searchOnly}/.`).existingPath).toBe(searchOnly);
      expect(resolvePathPrefixSync(`${searchOnly}/../live`).existingPath).toBe(live);
    } finally {
      fs.chmodSync(searchOnly, 0o700);
    }
  });

  it.each(["EACCES", "EIO", "ELOOP", "ENOTDIR"])("propagates %s from entry inspection", async code => {
    const directory = await tempRoot("fs-safe-prefix-inspect-error-");
    const failure = Object.assign(new Error("synthetic entry failure"), { code });
    const lstat = fs.lstatSync.bind(fs);
    const input = path.join(directory, "future");
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) === input) throw failure;
      return lstat(...args);
    });
    expect(() => resolvePathPrefixSync(input)).toThrow(failure);
  });

  it.each(["ENOENT", "EACCES", "EIO"])("does not reclassify readlink %s as a missing target", async code => {
    const directory = await tempRoot("fs-safe-prefix-readlink-error-");
    const alias = path.join(directory, "alias");
    fs.symlinkSync(directory, alias, directoryLink);
    const failure = Object.assign(new Error("synthetic readlink failure"), { code });
    const readlink = fs.readlinkSync.bind(fs);
    vi.spyOn(fs, "readlinkSync").mockImplementation((...args) => {
      if (String(args[0]) === alias) throw failure;
      return readlink(...args);
    });
    expect(() => resolvePathPrefixSync(alias)).toThrow(failure);
  });

  it.each(["ENOENT", "EACCES"])("does not fabricate a prefix after canonicalization %s", async code => {
    const directory = await tempRoot("fs-safe-prefix-canonical-error-");
    const failure = Object.assign(new Error("synthetic canonicalization failure"), { code });
    vi.spyOn(realpathSync, "native").mockImplementation(() => { throw failure; });
    expect(() => resolvePathPrefixSync(path.join(directory, "future"))).toThrow(failure);
  });

  it("rejects NUL bytes even after a missing component", async () => {
    const directory = await tempRoot("fs-safe-prefix-nul-");
    expect(() => resolvePathPrefixSync(`${directory}${path.sep}missing${path.sep}\0`))
      .toThrow(expect.objectContaining({ code: "invalid-path" }));
  });

  itPosix("preserves ordinary POSIX backslashes and drive-like names", async () => {
    const directory = await tempRoot("fs-safe-prefix-posix-");
    for (const name of ["C:notes", "a\\b"]) {
      const file = path.join(directory, name);
      fs.writeFileSync(file, "kept");
      expect(resolvePathPrefixSync(file).existingPath).toBe(file);
    }
  });

  itWin32.each(["drive-relative", "root-relative", "mixed-root-relative", "namespace"])(
    "anchors %s Windows input without rewriting link/..",
    async form => {
      const directory = realpathSync.native(fs.mkdtempSync(path.join(process.cwd(), ".fs-safe-prefix-windows-")));
      tempDirs.push(directory);
      fs.mkdirSync(path.join(directory, "deep", "dir"), { recursive: true });
      fs.symlinkSync(path.join(directory, "deep", "dir"), path.join(directory, "link"), "junction");
      const drive = path.parse(directory).root.slice(0, 2);
      let prefix: string;
      if (form === "drive-relative") prefix = `${drive}${path.relative(path.resolve(drive), directory)}`;
      else if (form === "namespace") prefix = path.toNamespacedPath(directory);
      else prefix = directory.slice(drive.length);
      let input = `${prefix}\\link\\..\\future`;
      if (form === "mixed-root-relative") input = input.replaceAll("\\", "/");
      const result = resolvePathPrefixSync(input);
      expect(result.existingPath).toBe(realpathSync.native(path.join(directory, "deep")));
      expect(result.unresolvedSegments).toEqual(["future"]);
      expect(path.parse(result.absolutePath).root).not.toBe("\\");
      expect(result.absolutePath).toContain("link\\..\\future");
    },
  );
});
