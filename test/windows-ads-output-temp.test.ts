import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, vi } from "vitest";
import {
  ensureDurableDirectory,
  syncDirectory,
} from "../src/directory-durability.js";
import { sha256File, sha256FileSync } from "../src/file-hash.js";
import { writeExternalFileWithinRoot } from "../src/output.js";
import {
  tempWorkspace,
  tempWorkspaceSync,
} from "../src/private-temp-workspace.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { resolveSecureTempRoot } from "../src/secure-temp-dir.js";
import { writeCallbackSibling } from "../src/sibling-staged-file.js";
import {
  writeSiblingTempFile,
  writeViaSiblingTempPath,
} from "../src/sibling-temp.js";
import { buildRandomTempFilePath, tempFile } from "../src/temp-target.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const aliasError = {
  code: "invalid-path",
  details: { reason: "windows-path-alias" },
};

describe("Windows filesystem namespace admission for output and temp helpers", () => {
  itWin32.each([undefined, "private-directory"] as const)(
    "rejects output roots and target parents before invoking a writer: %s",
    async (producerIsolation) => {
      const root = await tempRoot("fs-safe-ads-output-");
      const bucket = path.join(root, "bucket");
      await fs.mkdir(bucket);
      const writer = vi.fn(async (candidate: string) => {
        await fs.writeFile(candidate, "unexpected");
      });

      await expect(writeExternalFileWithinRoot({
        rootDir: `${root}::$INDEX_ALLOCATION`,
        path: "payload.bin",
        staging: "sibling",
        producerIsolation,
        write: writer,
      })).rejects.toMatchObject(aliasError);
      await expect(writeExternalFileWithinRoot({
        rootDir: root,
        path: path.join("bucket::$INDEX_ALLOCATION", "payload.bin"),
        staging: "sibling",
        producerIsolation,
        write: writer,
      })).rejects.toMatchObject(aliasError);

      expect(writer).not.toHaveBeenCalled();
      await expect(fs.readdir(bucket)).resolves.toEqual([]);
    },
  );

  itWin32("preserves output byte-limit validation before pathname admission", async () => {
    const writer = vi.fn(async () => undefined);
    await expect(writeExternalFileWithinRoot({
      rootDir: "C:\\output:hidden",
      path: "payload.bin",
      maxBytes: -1,
      write: writer,
    })).rejects.toBeInstanceOf(RangeError);
    expect(writer).not.toHaveBeenCalled();
  });

  itWin32("keeps output basename sanitization while rejecting namespace-bearing parents", async () => {
    const root = await tempRoot("fs-safe-ads-output-name-");
    const result = await writeExternalFileWithinRoot({
      rootDir: root,
      path: "report.txt:hidden",
      staging: "sibling",
      write: async (candidate) => await fs.writeFile(candidate, "safe"),
    });

    expect(path.basename(result.path)).not.toContain(":");
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("safe");
    await expect(fs.stat(path.join(root, "report.txt:hidden"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  itWin32("rejects sibling roots and callback-selected final streams before publication", async () => {
    const root = await tempRoot("fs-safe-ads-sibling-");
    const writeTemp = vi.fn(async (candidate: string) => await fs.writeFile(candidate, "data"));

    await expect(writeSiblingTempFile({
      dir: `${root}::$INDEX_ALLOCATION`,
      writeTemp,
      producerIsolation: "private-directory",
      resolveFinalPath: () => path.join(root, "final.bin"),
    })).rejects.toMatchObject(aliasError);
    expect(writeTemp).not.toHaveBeenCalled();

    const tempPath = path.join(root, "stage.tmp");
    const finalAlias = path.join(root, "final.bin:hidden");
    const producer = vi.fn(async (candidate: string) => await fs.writeFile(candidate, "staged"));
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const open = vi.spyOn(fs, "open");
    const rename = vi.spyOn(fs, "rename");
    await expect(writeCallbackSibling({
      tempPath,
      write: producer,
      producerIsolation: "private-directory",
      resolveFinalPath: () => finalAlias,
      syncTempFile: false,
      syncParentDir: false,
    })).rejects.toMatchObject(aliasError);
    expect(producer).toHaveBeenCalledOnce();
    expect(lstat.mock.calls.some(([candidate]) => String(candidate) === finalAlias)).toBe(false);
    expect(open.mock.calls.some(([candidate]) => String(candidate) === finalAlias)).toBe(false);
    expect(rename.mock.calls.some(([from, to]) =>
      String(from) === finalAlias || String(to) === finalAlias)).toBe(false);
    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(finalAlias)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  itWin32("rejects direct sibling targets before invoking their writer", async () => {
    const root = await tempRoot("fs-safe-ads-direct-sibling-");
    const directory = path.join(root, "target");
    await fs.mkdir(directory);
    const writeTemp = vi.fn(async (candidate: string) => await fs.writeFile(candidate, "data"));

    await expect(writeViaSiblingTempPath({
      rootDir: root,
      targetPath: path.join(`${directory}::$INDEX_ALLOCATION`, "payload.bin"),
      writeTemp,
    })).rejects.toMatchObject(aliasError);

    expect(writeTemp).not.toHaveBeenCalled();
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  itWin32("rejects async and sync workspace roots before creating children", async () => {
    const root = await tempRoot("fs-safe-ads-workspace-");
    const aliasRoot = `${root}::$INDEX_ALLOCATION`;

    await expect(tempWorkspace({ rootDir: aliasRoot, prefix: "workspace" }))
      .rejects.toMatchObject(aliasError);
    expect(() => tempWorkspaceSync({ rootDir: aliasRoot, prefix: "workspace" }))
      .toThrow(expect.objectContaining(aliasError));
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  itWin32("rejects workspace stream names with the existing file-name error shape", async () => {
    const root = await tempRoot("fs-safe-ads-workspace-name-");
    const workspace = await tempWorkspace({ rootDir: root, prefix: "workspace" });
    try {
      expect(() => workspace.path("payload.bin:hidden"))
        .toThrow(/Invalid temp workspace file name/u);
      await expect(workspace.write("payload.bin:hidden", "unexpected"))
        .rejects.toThrow(/Invalid temp workspace file name/u);
      await expect(fs.readdir(workspace.dir)).resolves.toEqual([]);
    } finally {
      await workspace.cleanup();
    }
  });

  itWin32("rejects temp roots before mkdtemp but still sanitizes requested file names", async () => {
    const root = await tempRoot("fs-safe-ads-temp-target-");
    const aliasRoot = `${root}::$INDEX_ALLOCATION`;

    await expect(tempFile({ rootDir: aliasRoot, prefix: "stage" }))
      .rejects.toMatchObject(aliasError);
    expect(() => buildRandomTempFilePath({
      rootDir: aliasRoot,
      prefix: "stage",
      now: 1,
      uuid: "00000000-0000-4000-8000-000000000000",
    })).toThrow(expect.objectContaining(aliasError));
    await expect(fs.readdir(root)).resolves.toEqual([]);

    const target = await tempFile({
      rootDir: root,
      prefix: "stage",
      fileName: "payload.bin:hidden",
    });
    try {
      expect(path.basename(target.path)).not.toContain(":");
    } finally {
      await target.cleanup();
    }
  });

  itWin32("rejects preferred and environment temp aliases before filesystem access", () => {
    const lstatSync = vi.fn(() => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o40700,
      uid: 501,
    }));
    const mkdirSync = vi.fn();
    const chmodSync = vi.fn();
    const accessSync = vi.fn();

    expect(() => resolveSecureTempRoot({
      accessSync,
      chmodSync,
      fallbackPrefix: "stage",
      getuid: () => 501,
      lstatSync,
      mkdirSync,
      platform: "win32",
      preferredDir: "C:\\Temp:secret",
      tmpdir: () => "C:\\Temp",
    })).toThrow(expect.objectContaining(aliasError));
    expect(lstatSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();

    expect(() => resolveSecureTempRoot({
      accessSync,
      chmodSync,
      fallbackPrefix: "stage",
      getuid: () => 501,
      lstatSync,
      mkdirSync,
      platform: "win32",
      tmpdir: () => "C:\\Temp:secret",
    })).toThrow(expect.objectContaining(aliasError));
    expect(lstatSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  itWin32("rejects publication source and target streams before mutation", async () => {
    const root = await tempRoot("fs-safe-ads-publish-");
    const source = path.join(root, "source.bin");
    const target = path.join(root, "target.bin");
    await fs.writeFile(source, "base");
    await fs.writeFile(`${source}:payload`, "hidden");

    await expect(publishFileExclusive({
      sourcePath: `${source}:payload`,
      targetPath: target,
      strategy: "link-or-copy",
    })).rejects.toMatchObject(aliasError);
    await expect(publishFileExclusive({
      sourcePath: source,
      targetPath: `${target}:payload`,
      strategy: "link-or-copy",
    })).rejects.toMatchObject(aliasError);

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${target}:payload`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itWin32("rejects durable-directory aliases before sync or creation", async () => {
    const root = await tempRoot("fs-safe-ads-durability-");
    const aliasRoot = `${root}::$INDEX_ALLOCATION`;

    await expect(syncDirectory(aliasRoot)).rejects.toMatchObject(aliasError);
    await expect(ensureDurableDirectory({
      directoryPath: path.join(aliasRoot, "created"),
    })).rejects.toMatchObject(aliasError);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  itWin32("rejects stream and index hashing before path inspection", async () => {
    const root = await tempRoot("fs-safe-ads-hash-");
    const carrier = path.join(root, "carrier.bin");
    const stream = `${carrier}:payload`;
    await fs.writeFile(carrier, "base");
    await fs.writeFile(stream, "hidden");
    const aliases = [stream, `${carrier}::$INDEX_ALLOCATION`];
    const observations = [
      vi.spyOn(fsSync, "lstatSync"),
      vi.spyOn(fsSync, "openSync"),
      vi.spyOn(fsSync, "fstatSync"),
      vi.spyOn(fsSync, "readSync"),
    ];

    for (const alias of aliases) {
      await expect(sha256File(alias)).rejects.toMatchObject(aliasError);
      expect(() => sha256FileSync(alias)).toThrow(expect.objectContaining(aliasError));
    }
    for (const observation of observations) expect(observation).not.toHaveBeenCalled();
  });

  itPosix("keeps colon-bearing POSIX roots and file names usable", async () => {
    const parent = await tempRoot("fs-safe-posix-colon-");
    const root = path.join(parent, "root:scope");
    await fs.mkdir(root);

    const workspace = await tempWorkspace({ rootDir: root, prefix: "work:space" });
    await workspace.write("entry:value", "workspace");
    await expect(workspace.read("entry:value")).resolves.toEqual(Buffer.from("workspace"));
    await workspace.cleanup();

    const temporary = await tempFile({
      rootDir: root,
      prefix: "stage:prefix",
      fileName: "payload:name.bin",
    });
    await temporary.cleanup();

    const siblingSource = path.join(root, "stage:source");
    const siblingFinal = path.join(root, "final:value");
    await writeCallbackSibling({
      tempPath: siblingSource,
      write: async (candidate) => await fs.writeFile(candidate, "sibling"),
      resolveFinalPath: () => siblingFinal,
      syncTempFile: false,
      syncParentDir: false,
    });
    await expect(fs.readFile(siblingFinal, "utf8")).resolves.toBe("sibling");

    const publishSource = path.join(root, "publish:source");
    const publishTarget = path.join(root, "publish:target");
    await fs.writeFile(publishSource, "publish");
    await publishFileExclusive({
      sourcePath: publishSource,
      targetPath: publishTarget,
      strategy: "link-or-copy",
    });
    await expect(sha256File(publishTarget)).resolves.toMatchObject({ bytes: 7 });

    const durable = path.join(root, "durable:directory");
    await ensureDurableDirectory({ directoryPath: durable });
    await expect(syncDirectory(durable)).resolves.toHaveProperty("status");

    const secure = resolveSecureTempRoot({
      accessSync: () => undefined,
      chmodSync: () => undefined,
      fallbackPrefix: "stage",
      getuid: () => 501,
      lstatSync: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o40700,
        uid: 501,
      }),
      mkdirSync: () => undefined,
      platform: process.platform,
      preferredDir: root,
      tmpdir: () => parent,
    });
    expect(secure).toBe(root);
  });
});
