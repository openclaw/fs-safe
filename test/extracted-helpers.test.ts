import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "../src/archive.js";
import {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
} from "../src/install-path.js";
import { basenameFromMediaSource, safeFileURLToPath } from "../src/local-file-access.js";
import { formatPosixMode } from "../src/mode.js";
import { isPathInside, isWithinDir, resolveSafeBaseDir } from "../src/path.js";
import { tryReadJson, tryReadJsonSync, writeJson, writeJsonSync } from "../src/json.js";
import {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  readSecretFileSync,
  tryReadSecretFileSync,
  writeSecretFileAtomic,
} from "../src/secret-file.js";

const { tempRoot } = useTempDirs();



describe("local file access helpers", () => {
  it("accepts local file URLs and rejects remote hosts or encoded separators", () => {
    const [validUrl, expectedPath] = process.platform === "win32"
      ? ["file:///C:/tmp/demo.txt", "C:\\tmp\\demo.txt"]
      : ["file:///tmp/demo.txt", "/tmp/demo.txt"];
    expect(safeFileURLToPath(validUrl)).toBe(expectedPath);
    expect(() => safeFileURLToPath("file://example.com/tmp/demo.txt")).toThrow(/remote hosts/);
    expect(() => safeFileURLToPath("file:///tmp/a%2Fb.txt")).toThrow(/encode path separators/);
  });

  it("extracts basenames from file paths and URLs", () => {
    expect(basenameFromMediaSource("https://example.com/files/report.txt?x=1")).toBe("report.txt");
    expect(basenameFromMediaSource("/tmp/report.txt")).toBe("report.txt");
  });
});

describe("path helpers", () => {
  it("checks containment and formats modes", () => {
    // Use path.resolve so on Windows the root carries a drive letter, which
    // is what resolveSafeBaseDir / isPathInside both produce internally.
    const root = path.resolve(path.sep, "tmp", "root");
    const otherRoot = path.resolve(path.sep, "tmp", "root-other");
    expect(resolveSafeBaseDir(root)).toBe(`${root}${path.sep}`);
    expect(isWithinDir(root, path.join(root, "file.txt"))).toBe(true);
    expect(isPathInside(root, otherRoot)).toBe(false);
    expect(formatPosixMode(0o100755)).toBe("755");
  });
});

describe("install path helpers", () => {
  it("normalizes path segments and resolves install dirs under the base", () => {
    expect(safeDirName("../demo/plugin")).toBe("..__demo__plugin");
    expect(safePathSegmentHashed("../../demo/skill")).toMatch(/-[a-f0-9]{10}$/);
    expect(
      resolveSafeInstallDir({
        baseDir: "/tmp/plugins",
        id: "@openclaw/matrix",
        invalidNameMessage: "invalid plugin name",
      }),
    ).toEqual({
      ok: true,
      path: path.join("/tmp/plugins", "@openclaw__matrix"),
    });
  });

  it("validates canonical paths under a base directory", async () => {
    const baseDir = await tempRoot("fs-safe-install-");
    const candidate = path.join(baseDir, "tools", "plugin");
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await expect(
      assertCanonicalPathWithinBase({
        baseDir,
        candidatePath: candidate,
        boundaryLabel: "install directory",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("json helpers", () => {
  it("writes and reads sync and async JSON files", async () => {
    const root = await tempRoot("fs-safe-json-");
    const syncPath = path.join(root, "sync", "state.json");
    const asyncPath = path.join(root, "async", "state.json");

    writeJsonSync(syncPath, { ok: true });
    expect(tryReadJsonSync(syncPath)).toEqual({ ok: true });

    await writeJson(asyncPath, { ok: true }, { trailingNewline: true });
    await expect(tryReadJson(asyncPath)).resolves.toEqual({ ok: true });
    await expect(fs.readFile(asyncPath, "utf8")).resolves.toBe("{\n  \"ok\": true\n}\n");
  });
});

describe("archive entry helpers", () => {
  it("validates and strips archive paths", () => {
    expect(isWindowsDrivePath("C:\\temp\\file.txt")).toBe(true);
    expect(isWindowsDrivePath("C:secret.txt")).toBe(true);
    expect(isWindowsDrivePath("nested/C:secret.txt")).toBe(true);
    expect(normalizeArchiveEntryPath("dir\\file.txt")).toBe("dir/file.txt");
    expect(stripArchivePath("a//b/file.txt", 1)).toBe("b/file.txt");
    expect(stripArchivePath("./", 0)).toBeNull();
    expect(() => validateArchiveEntryPath("../escape.txt", { escapeLabel: "targetDir" })).toThrow(
      "archive entry escapes targetDir: ../escape.txt",
    );
    expect(() => validateArchiveEntryPath("C:\\temp\\file.txt")).toThrow(
      "archive entry uses a drive path",
    );
    expect(() => validateArchiveEntryPath("C:secret.txt")).toThrow(
      "archive entry uses a drive path",
    );
    expect(() => validateArchiveEntryPath("nested/C:secret.txt")).toThrow(
      "archive entry uses a drive path",
    );
    expect(() => validateArchiveEntryPath("nested/secret\0.txt")).toThrow(
      "archive entry contains a NUL byte",
    );
  });

  it("resolves archive output paths under the destination root", () => {
    const rootDir = path.join(path.sep, "tmp", "archive-root");
    expect(
      resolveArchiveOutputPath({
        rootDir,
        relPath: "sub/file.txt",
        originalPath: "sub/file.txt",
      }),
    ).toBe(path.resolve(rootDir, "sub/file.txt"));
    expect(() =>
      resolveArchiveOutputPath({
        rootDir,
        relPath: "../escape.txt",
        originalPath: "../escape.txt",
        escapeLabel: "targetDir",
      }),
    ).toThrow("archive entry escapes targetDir: ../escape.txt");
  });
});

describe("secret file helpers", () => {
  it("reads and validates secret files", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const filePath = path.join(root, "secret.txt");
    await fs.writeFile(filePath, " top-secret \n", "utf8");

    expect(readSecretFileSync(filePath, "Gateway password")).toBe("top-secret");
    expect(tryReadSecretFileSync(filePath, "Gateway password")).toBe("top-secret");

    await fs.writeFile(filePath, "x".repeat(DEFAULT_SECRET_FILE_MAX_BYTES + 1), "utf8");
    expect(() => readSecretFileSync(filePath, "Gateway password")).toThrow(
      `Gateway password file at ${filePath} exceeds ${DEFAULT_SECRET_FILE_MAX_BYTES} bytes.`,
    );
  });

  it("writes private secret files without following symlink parents", async () => {
    const root = await tempRoot("fs-safe-secret-write-");
    const filePath = path.join(root, "nested", "auth.json");
    await writeSecretFileAtomic({
      rootDir: root,
      filePath,
      content: '{"ok":true}\n',
    });

    expect(readSecretFileSync(filePath, "Gateway password")).toBe('{"ok":true}');
    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.dirname(filePath));
      const fileStat = await fs.stat(filePath);
      expect(dirStat.mode & 0o777).toBe(PRIVATE_SECRET_DIR_MODE);
      expect(fileStat.mode & 0o777).toBe(PRIVATE_SECRET_FILE_MODE);
    }

    const outside = await tempRoot("fs-safe-secret-outside-");
    await fs.symlink(outside, path.join(root, "linked"));
    await expect(
      writeSecretFileAtomic({
        rootDir: root,
        filePath: path.join(root, "linked", "auth.json"),
        content: '{"ok":true}\n',
      }),
    ).rejects.toThrow("must not be a symlink");
  });
});
