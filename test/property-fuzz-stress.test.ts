import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import {
  createArchiveOutputPathTracker,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "../src/archive-entry.js";
import { shouldExtractArchiveEntry } from "../src/archive-policy.js";
import { createTarEntryPreflightChecker } from "../src/archive-tar.js";
import { isUnsafeDeviceReadPath } from "../src/device-path.js";
import { sanitizeUntrustedFileName } from "../src/filename.js";
import { isPathInside } from "../src/path.js";
import {
  ROOT_PATH_ALIAS_POLICIES,
  resolveRootPath,
  resolveRootPathSync,
} from "../src/root-path.js";
import {
  isSafePathSegment,
  sanitizeSafePathSegment,
} from "../src/safe-path-segment.js";

const SEEDS = [0x00000001, 0x5eedc0de, 0x9e3779b9, 0xc001d00d, 0xffffffff] as const;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INVALID_FILENAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u;
const { tempRoot } = useTempDirs();

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

const TOKENS = [
  "", ".", "..", "...", "/", "\\", "//", "\\\\", ":", "C:", "C:relative",
  "CON", "nul.txt", " ", "\t", "\n", "\0", "é", "\u2028", "\u2029", "\u202e",
  "a", "Z", "0", "_", "-",
] as const;

function generatedString(random: () => number, maxTokens = 16): string {
  const count = Math.floor(random() * (maxTokens + 1));
  let result = "";
  for (let index = 0; index < count; index += 1) {
    result += TOKENS[Math.floor(random() * TOKENS.length)];
  }
  return result;
}

function referenceIsPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function errorSnapshot(error: unknown): { name: string; code?: unknown; message: string } {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof candidate?.name === "string" ? candidate.name : typeof error,
    code: candidate?.code,
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
  };
}

async function settleAsync<T>(action: () => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; error: ReturnType<typeof errorSnapshot> }
> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, error: errorSnapshot(error) };
  }
}

function settleSync<T>(action: () => T):
  { ok: true; value: T } | { ok: false; error: ReturnType<typeof errorSnapshot> } {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    return { ok: false, error: errorSnapshot(error) };
  }
}

describe("seeded path property stress", () => {
  it.each(SEEDS)("keeps segment and filename sanitizers closed and idempotent (seed %i)", (seed) => {
    const random = seededRandom(seed);
    for (let index = 0; index < 2_000; index += 1) {
      const input = generatedString(random);
      for (const allowDotPrefix of [false, true]) {
        const segment = sanitizeSafePathSegment(input, "fallback", { allowDotPrefix });
        expect(isSafePathSegment(segment, { allowDotPrefix }), `${seed}:${index}:${input}`).toBe(true);
        expect(
          sanitizeSafePathSegment(segment, "fallback", { allowDotPrefix }),
          `${seed}:${index}:${input}`,
        ).toBe(segment);
      }

      const fileName = sanitizeUntrustedFileName(input, "fallback.bin");
      expect(fileName, `${seed}:${index}:${input}`).toBe(path.posix.basename(fileName));
      expect(fileName, `${seed}:${index}:${input}`).toBe(path.win32.basename(fileName));
      expect(fileName.length, `${seed}:${index}:${input}`).toBeLessThanOrEqual(200);
      expect(INVALID_FILENAME_CHARACTERS.test(fileName), `${seed}:${index}:${input}`).toBe(false);
      expect(isUnsafeDeviceReadPath(`C:\\tmp\\${fileName}`, { platform: "win32" })).toBe(false);
      expect(sanitizeUntrustedFileName(fileName, "fallback.bin")).toBe(fileName);
    }
  });

  it.each(SEEDS)("matches path.relative containment semantics (seed %i)", (seed) => {
    const random = seededRandom(seed);
    for (let index = 0; index < 5_000; index += 1) {
      const root = path.join(path.sep, "tmp", generatedString(random, 8));
      const target = path.join(path.sep, "tmp", generatedString(random, 12));
      expect(isPathInside(root, target), `${seed}:${index}:${root}:${target}`).toBe(
        referenceIsPathInside(root, target),
      );
    }
  });

  it.each(SEEDS)("keeps archive validation, stripping, and output containment aligned (seed %i)", (seed) => {
    const random = seededRandom(seed);
    for (let index = 0; index < 2_000; index += 1) {
      const input = generatedString(random);
      let accepted = true;
      try {
        validateArchiveEntryPath(input);
      } catch (error) {
        accepted = false;
        expect(CONTROL_CHARACTERS.test(errorSnapshot(error).message), `${seed}:${index}:${input}`)
          .toBe(false);
      }
      let slashNormalizedAccepted = true;
      try {
        validateArchiveEntryPath(input.replaceAll("\\", "/"));
      } catch {
        slashNormalizedAccepted = false;
      }
      expect(accepted, `${seed}:${index}:${input}`).toBe(slashNormalizedAccepted);
      if (!accepted) continue;

      for (const stripComponents of [0, 1, 2, 3]) {
        const stripped = stripArchivePath(input, stripComponents);
        if (!stripped) continue;
        try {
          validateArchiveEntryPath(stripped);
        } catch (error) {
          expect(
            CONTROL_CHARACTERS.test(errorSnapshot(error).message),
            `${seed}:${index}:${input}`,
          ).toBe(false);
          continue;
        }
        const rootDir = path.resolve("/tmp", "fs-safe-archive-property-root");
        const outputPath = resolveArchiveOutputPath({
          rootDir,
          relPath: stripped,
          originalPath: input,
        });
        expect(isPathInside(rootDir, outputPath), `${seed}:${index}:${input}`).toBe(true);
      }
    }
  });

  it.each(SEEDS)("keeps async and sync root resolution equivalent (seed %i)", async (seed) => {
    const base = await tempRoot(`fs-safe-root-property-${seed}-`);
    const rootDir = path.join(base, "root");
    const outsideDir = path.join(base, "outside");
    await fs.mkdir(path.join(rootDir, "real", "nested"), { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(rootDir, "real", "file.txt"), "inside");
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside");
    if (process.platform !== "win32") {
      await fs.symlink("real", path.join(rootDir, "alias"), "dir");
      await fs.symlink(outsideDir, path.join(rootDir, "escape"), "dir");
    }
    const rootCanonicalPath = await fs.realpath(rootDir);
    const random = seededRandom(seed);
    const fixed = [
      "", ".", "real", "real/file.txt", "real/missing.txt", "real/nested/../file.txt",
      "../outside/secret.txt", "alias/file.txt", "alias/nested/../file.txt", "escape/secret.txt",
    ];
    const candidates = [
      ...fixed,
      ...Array.from({ length: 128 }, () => generatedString(random, 8)),
    ];
    const variants = [
      {},
      { rejectSymlinks: true },
      { policy: ROOT_PATH_ALIAS_POLICIES.strict },
      { policy: ROOT_PATH_ALIAS_POLICIES.unlinkTarget },
    ] as const;
    for (const [variantIndex, variant] of variants.entries()) {
      for (const candidate of candidates) {
        const params = {
          ...variant,
          absolutePath: path.join(rootDir, candidate),
          rootPath: rootDir,
          rootCanonicalPath,
          boundaryLabel: "property root",
        } as const;
        const [asyncResult, syncResult] = await Promise.all([
          settleAsync(() => resolveRootPath(params)),
          Promise.resolve(settleSync(() => resolveRootPathSync(params))),
        ]);
        expect(asyncResult, `${seed}:${variantIndex}:${candidate}`).toEqual(syncResult);
        if (!asyncResult.ok) {
          expect(
            CONTROL_CHARACTERS.test(asyncResult.error.message),
            `${seed}:${variantIndex}:${candidate}`,
          ).toBe(false);
        }
      }
    }
  }, 10_000);
});

describe("minimal control-character diagnostic regressions", () => {
  it("escapes archive entry controls across validation and policy errors", () => {
    expect(() => validateArchiveEntryPath("\0")).toThrow(
      "archive entry contains a NUL byte: \\u0000",
    );
    expect(() => validateArchiveEntryPath("/bad\nname")).toThrow(
      "archive entry is absolute: /bad\\u000aname",
    );
    expect(() =>
      shouldExtractArchiveEntry({
        filter: () => "skip",
        entry: { path: "bad\tname", kind: "file", size: 0 },
      }),
    ).toThrow("archive entry rejected by filter: bad\\u0009name");

    const checkTarEntry = createTarEntryPreflightChecker({ rootDir: path.resolve("/tmp") });
    expect(() => checkTarEntry({ path: "bad\nlink", type: "SymbolicLink", size: 0 }))
      .toThrow("tar entry is a link: bad\\u000alink");

    const trackOutputPath = createArchiveOutputPathTracker();
    trackOutputPath("a/../same", "first");
    expect(() => trackOutputPath("same", "second\rname"))
      .toThrow("archive entries collide at output path same: second\\u000dname");
  });

  it("rejects NUL resolver inputs uniformly and escapes controls in boundary errors", async () => {
    const base = await tempRoot("fs-safe-root-error-detail-");
    const rootDir = path.join(base, "root");
    await fs.mkdir(rootDir);
    const nulParams = {
      absolutePath: path.join(rootDir, "bad\0name"),
      rootPath: rootDir,
      rootCanonicalPath: rootDir,
      boundaryLabel: "root",
    } as const;
    const [asyncNul, syncNul] = await Promise.all([
      settleAsync(() => resolveRootPath(nulParams)),
      Promise.resolve(settleSync(() => resolveRootPathSync(nulParams))),
    ]);
    expect(asyncNul).toEqual(syncNul);
    expect(asyncNul).toMatchObject({
      ok: false,
      error: { name: "FsSafeError", code: "invalid-path", message: "absolute path contains a NUL byte" },
    });

    const outsideParams = {
      ...nulParams,
      absolutePath: path.join(base, "outside\nname"),
    };
    const [asyncOutside, syncOutside] = await Promise.all([
      settleAsync(() => resolveRootPath(outsideParams)),
      Promise.resolve(settleSync(() => resolveRootPathSync(outsideParams))),
    ]);
    expect(asyncOutside).toEqual(syncOutside);
    expect(asyncOutside).toMatchObject({ ok: false });
    if (!asyncOutside.ok) {
      expect(asyncOutside.error.message).toContain("outside\\u000aname");
      expect(CONTROL_CHARACTERS.test(asyncOutside.error.message)).toBe(false);
    }
  });
});
