import fs from "node:fs";
import { tmpdir as getOsTmpDir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { resolveSecureTempRoot } from "../src/secure-temp-dir.js";
import { itPosix } from "./helpers/vitest.js";

const temporaryDirectories: string[] = [];
const itPosixNonRoot = it.runIf(
  process.platform !== "win32" &&
  typeof process.geteuid === "function" &&
  process.geteuid() !== 0,
);

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(getOsTmpDir(), `fs-safe-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function forceSplitCredentialProbe(): void {
  const effectiveUid = process.geteuid!();
  const effectiveGid = process.getegid!();
  vi.spyOn(process, "getuid").mockReturnValue(effectiveUid === 0 ? 1 : effectiveUid - 1);
  vi.spyOn(process, "geteuid").mockReturnValue(effectiveUid);
  vi.spyOn(process, "getgid").mockReturnValue(effectiveGid);
  vi.spyOn(process, "getegid").mockReturnValue(effectiveGid);
}

function nodeErrorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("secure temp operation-probe canonicalization", () => {
  itPosixNonRoot("admits a writable unreadable directory through the shared canonicalizer", () => {
    forceSplitCredentialProbe();
    const base = createTemporaryDirectory("effective-search-only");
    const preferredDir = path.join(base, "preferred");
    fs.mkdirSync(preferredDir, { mode: 0o700 });
    fs.chmodSync(preferredDir, 0o300);

    try {
      expect(resolveSecureTempRoot({
        fallbackPrefix: "example",
        preferredDir,
      })).toBe(preferredDir);
      expect(fs.statSync(preferredDir).mode & 0o777).toBe(0o300);
    } finally {
      fs.chmodSync(preferredDir, 0o700);
    }
    expect(fs.readdirSync(preferredDir)).toEqual([]);
  });

  itPosix("fails closed when shared canonicalization cannot establish a receipt", () => {
    forceSplitCredentialProbe();
    const base = createTemporaryDirectory("effective-canonical-failure");
    const preferredDir = path.join(base, "preferred");
    const fallbackBase = path.join(base, "fallback");
    fs.mkdirSync(preferredDir, { mode: 0o700 });
    fs.mkdirSync(fallbackBase, { mode: 0o700 });
    const fallbackPath = path.join(fallbackBase, `example-${process.geteuid!()}`);
    fs.mkdirSync(fallbackPath, { mode: 0o700 });
    const canonicalize = realpathSync.native;
    const canonicalizeSpy = vi.spyOn(realpathSync, "native").mockImplementation((candidate) => {
      if (path.resolve(candidate) === path.resolve(preferredDir)) {
        throw nodeErrorWithCode("EACCES");
      }
      return canonicalize(candidate);
    });
    const openSync = vi.spyOn(fs, "openSync");

    expect(resolveSecureTempRoot({
      fallbackPrefix: "example",
      preferredDir,
      tmpdir: () => fallbackBase,
    })).toBe(fallbackPath);
    expect(canonicalizeSpy).toHaveBeenCalledWith(preferredDir);
    expect(openSync.mock.calls.some(([candidate]) =>
      String(candidate).startsWith(`${preferredDir}${path.sep}`),
    )).toBe(false);
    expect(fs.readdirSync(preferredDir)).toEqual([]);
    expect(fs.readdirSync(fallbackPath)).toEqual([]);
  });

  itPosixNonRoot("admits a writable directory through physical symlink-parent traversal", () => {
    forceSplitCredentialProbe();
    const base = createTemporaryDirectory("effective-dotdot-positive");
    const lexicalParent = path.join(base, "lexical");
    const canonicalParent = path.join(base, "canonical");
    const canonicalChild = path.join(canonicalParent, "child");
    const linkPath = path.join(lexicalParent, "link");
    fs.mkdirSync(lexicalParent, { mode: 0o700 });
    fs.mkdirSync(canonicalChild, { recursive: true, mode: 0o700 });
    fs.symlinkSync(canonicalChild, linkPath, "dir");
    const candidate = `${linkPath}${path.sep}..`;

    expect(resolveSecureTempRoot({
      fallbackPrefix: "example",
      preferredDir: candidate,
    })).toBe(candidate);
    expect(fs.readdirSync(lexicalParent)).toEqual(["link"]);
    expect(fs.readdirSync(canonicalParent)).toEqual(["child"]);
  });
});
