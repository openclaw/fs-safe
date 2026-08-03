import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoOutsideWrite, makeTempLayout } from "./helpers/security.js";
import { useTempDirs } from "./helpers/vitest.js";
import { safeFileURLToPath } from "../src/local-file-access.js";
import { assertCanonicalPathWithinBase, resolveSafeInstallDir } from "../src/install-path.js";
import { createJsonStore } from "../src/json-document-store.js";
import { movePathToTrash } from "../src/trash.js";
import { resolveArchiveOutputPath, validateArchiveEntryPath } from "../src/archive-entry.js";
import { prepareArchiveOutputPath } from "../src/archive-staging.js";
import { sanitizeTempFileName, tempFile } from "../src/temp-target.js";
import { walkDirectory, walkDirectorySync } from "../src/walk.js";

const { tempDirs } = useTempDirs();

const ARCHIVE_ESCAPE_PAYLOADS = [
  "../evil.txt",
  "../../evil.txt",
  "nested/../../evil.txt",
  "/absolute/evil.txt",
  "//server/share/evil.txt",
  "C:/Windows/win.ini",
  "C:\\Windows\\win.ini",
  "..\\evil.txt",
  "nested\\..\\..\\evil.txt",
] as const;

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("additional helper boundary bypass attempts", () => {
  it("rejects archive traversal payloads before resolving output paths", async () => {
    const layout = await makeTempLayout("fs-safe-archive-payloads", tempDirs);

    for (const payload of ARCHIVE_ESCAPE_PAYLOADS) {
      expect(() => validateArchiveEntryPath(payload), `validate ${payload}`).toThrow();
      await expect(
        prepareArchiveOutputPath({ destDir: layout.root, relativePath: payload, originalPath: payload }),
      ).rejects.toThrow();
    }
  });

  it("keeps archive output resolution inside the destination for benign weird names", async () => {
    const layout = await makeTempLayout("fs-safe-archive-literals", tempDirs);
    const payloads = ["%2e%2e%2fevil.txt", "..%2fevil.txt", "safe/..hidden/file.txt"];

    for (const payload of payloads) {
      validateArchiveEntryPath(payload);
      const output = resolveArchiveOutputPath({ rootDir: layout.root, relPath: payload, originalPath: payload });
      expect(output.startsWith(`${layout.root}${path.sep}`)).toBe(true);
    }
  });

  it("sanitizes temp file names and keeps temp file helpers inside their created directory", async () => {
    const layout = await makeTempLayout("fs-safe-temp", tempDirs);
    expect(sanitizeTempFileName("../../evil.txt")).toBe("evil.txt");
    if (process.platform !== "win32") {
      // On windows "\" is a reserved path separator and cannot appear in a
      // filename, so this case only exercises the posix sanitizer where "\"
      // is a literal name character that needs neutralizing.
      expect(sanitizeTempFileName("..\\evil.txt")).toBe("..-evil.txt");
    }
    expect(sanitizeTempFileName("\u0000../evil.txt")).toBe("evil.txt");

    const target = await tempFile({ rootDir: layout.root, prefix: "../../prefix", fileName: "../../evil.txt" });
    tempDirs.push(target.dir);
    expect(target.dir.startsWith(`${layout.root}${path.sep}`)).toBe(true);
    expect(target.path).toBe(path.join(target.dir, "evil.txt"));
    expect(target.file("../../other.txt")).toBe(path.join(target.dir, "other.txt"));
    await target.cleanup();
    await expect(fsp.stat(target.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects remote or encoded-separator file URLs while accepting local file URLs", () => {
    const local = pathToFileURL(path.join(os.tmpdir(), "safe.txt")).toString();
    expect(safeFileURLToPath(local)).toBe(path.join(os.tmpdir(), "safe.txt"));
    expect(() => safeFileURLToPath("https://example.com/secret.txt")).toThrow();
    expect(() => safeFileURLToPath("file://evil.example/secret.txt")).toThrow();
    expect(() => safeFileURLToPath("file:///tmp/%2Fetc/passwd")).toThrow();
    expect(() => safeFileURLToPath("file:///tmp/%5Cevil")).toThrow();
  });

  it("keeps install directories and canonical base checks inside their base", async () => {
    const layout = await makeTempLayout("fs-safe-install", tempDirs);
    const safe = resolveSafeInstallDir({ baseDir: layout.root, id: "../../evil/pkg", invalidNameMessage: "bad package" });
    expect(safe).toMatchObject({ ok: true });
    if (!safe.ok) throw new Error("expected safe install dir");
    expect(safe.path.startsWith(`${layout.root}${path.sep}`)).toBe(true);

    await expect(
      assertCanonicalPathWithinBase({ baseDir: layout.root, candidatePath: layout.outsideFile, boundaryLabel: "install base" }),
    ).rejects.toThrow();
    const insideDir = path.join(layout.root, "inside");
    await fsp.mkdir(insideDir);
    await expect(
      assertCanonicalPathWithinBase({
        baseDir: layout.root,
        boundaryLabel: "install base",
        candidatePath: path.join(insideDir, "future-file.txt"),
      }),
    ).resolves.toBeUndefined();
  });

  it("walks do not follow symlinks by default and do not loop when following cycles", async () => {
    const layout = await makeTempLayout("fs-safe-walk", tempDirs);
    await fsp.mkdir(path.join(layout.root, "dir"));
    await fsp.writeFile(path.join(layout.root, "dir", "inside.txt"), "inside");
    await fsp.symlink(layout.outside, path.join(layout.root, "outside-link"), "dir");
    await fsp.symlink(layout.root, path.join(layout.root, "dir", "cycle"), "dir");

    const skipped = await walkDirectory(layout.root);
    expect(skipped.entries.some((entry) => entry.path.startsWith(layout.outside))).toBe(false);
    expect(skipped.entries.some((entry) => entry.relativePath.includes("outside-link"))).toBe(false);

    const followed = await walkDirectory(layout.root, { symlinks: "follow", maxEntries: 20 });
    expect(followed.entries.length).toBeLessThanOrEqual(20);
    expect(followed.entries.some((entry) => entry.path.startsWith(layout.outside))).toBe(false);

    const syncFollowed = walkDirectorySync(layout.root, { symlinks: "follow", maxEntries: 20 });
    expect(syncFollowed.entries.length).toBeLessThanOrEqual(20);
  });

  it("refuses to trash targets outside explicit allowed roots and does not move them", async () => {
    const layout = await makeTempLayout("fs-safe-trash", tempDirs);
    await expect(movePathToTrash(layout.outsideFile, { allowedRoots: [layout.root] })).rejects.toThrow();
    await expectNoOutsideWrite(layout);
  });

  it("json stores cannot bypass adapter-enforced root checks through lock/update flow", async () => {
    const layout = await makeTempLayout("fs-safe-json-store", tempDirs);
    const filePath = path.join(layout.root, "state.json");
    const adapter = {
      filePath,
      async readIfExists(): Promise<{ ok: boolean } | undefined> {
        try {
          return JSON.parse(await fsp.readFile(filePath, "utf8")) as { ok: boolean };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      async readRequired(): Promise<{ ok: boolean }> {
        return JSON.parse(await fsp.readFile(filePath, "utf8")) as { ok: boolean };
      },
      async write(value: { ok: boolean }): Promise<void> {
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(`${layout.root}${path.sep}`)) {
          throw new Error("adapter escaped root");
        }
        await fsp.writeFile(filePath, JSON.stringify(value));
      },
    };
    const store = createJsonStore(adapter, { lock: true });
    await expect(store.updateOr({ ok: false }, () => ({ ok: true }))).resolves.toEqual({ ok: true });
    await expect(fsp.readFile(filePath, "utf8")).resolves.toBe('{"ok":true}');
    await expectNoOutsideWrite(layout);
  });
});
