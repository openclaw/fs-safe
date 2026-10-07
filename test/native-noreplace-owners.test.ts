import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retainEntryForPublication, retainSymlinkInDirectory, stageFileInDirectory } from "../src/advanced.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { NATIVE_NOREPLACE_UNSUPPORTED } from "../src/native-noreplace.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { replaceDirectoryAtomic } from "../src/replace-directory.js";
import { tempWorkspace } from "../src/temp.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const native = loadTestNative("optional");
const { tempRoot } = useRealTempDirs();
const unsupported = () => Object.assign(new Error("renameat2 RENAME_NOREPLACE: EINVAL"), { code: NATIVE_NOREPLACE_UNSUPPORTED });
const fail = () => { throw unsupported(); };
const expected = { code: "helper-unavailable", message: expect.stringContaining("RENAME_NOREPLACE") };
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

describe.skipIf(!native || process.platform === "win32")("no-replace publication owners", () => {
  it.each(["auto", "require"] as const)("handles private producer workspace promotion in %s", async mode => {
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: fail }));
    const directory = await tempRoot("fs-safe-noreplace-producer-");
    let produced = 0;
    const write = () => writeSiblingTempFile({
      dir: directory, producerIsolation: "private-directory", chmodDir: false,
      writeTemp: async candidate => { produced++; await fs.writeFile(candidate, "content"); },
      resolveFinalPath: () => path.join(directory, "final"),
    });
    if (mode === "auto") {
      await write();
      await write();
      expect(produced).toBe(2);
      expect(await fs.readdir(directory)).toEqual(["final"]);
      expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("content");
    } else {
      await expect(write()).rejects.toMatchObject(expected);
      expect(await fs.readdir(directory)).not.toContain("final");
    }
  });

  it.each(["auto", "require"] as const)("fails closed for native-only file publication in %s", async mode => {
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: fail }));
    const directory = await tempRoot("fs-safe-noreplace-owners-");
    const stage = await stageFileInDirectory({ directory, content: "content" });
    await expect(stage.publish("target", { overwrite: false })).rejects.toMatchObject(expected);
    expect(await stage.cleanup()).toMatchObject({ status: "removed", publication: { status: "not-published" } });
    const sourcePath = path.join(directory, "source");
    await fs.writeFile(sourcePath, "source");
    const publication = publishFileExclusive({ sourcePath, targetPath: path.join(directory, "target"), strategy: "rename-noreplace" });
    if (mode === "auto" && process.platform === "linux") {
      await expect(publication).resolves.toMatchObject({ method: "rename-noreplace", fallback: "link-unlink" });
      expect(await fs.readdir(directory)).toEqual(["target"]);
    } else {
      await expect(publication).rejects.toMatchObject(expected);
      expect(await fs.readdir(directory)).toEqual(["source"]);
    }
  });

  it("preserves an unpublished directory replacement without an uncertain transition", async () => {
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplaceWithIdentity: fail }));
    const directory = await tempRoot("fs-safe-noreplace-directory-");
    const stagedDir = path.join(directory, "stage");
    const targetDir = path.join(directory, "target");
    await fs.mkdir(stagedDir);
    await fs.writeFile(path.join(stagedDir, "source"), "source");
    await expect(replaceDirectoryAtomic({ stagedDir, targetDir })).rejects.toMatchObject({
      code: "helper-unavailable", details: { publication: "not-published" },
    });
    expect(await fs.readdir(directory)).toEqual(["stage"]);
  });

  it.each(["file", "directory", "symlink"] as const)("retains the one-way %s source on unsupported publication", async kind => {
    __setNativeLoaderForTest(() => ({ ...native!, publishRetainedEntryNoReplace() {
      return { outcome: "not-published", errorCode: NATIVE_NOREPLACE_UNSUPPORTED, errorMessage: unsupported().message };
    } }));
    const directory = await tempRoot("fs-safe-noreplace-retained-");
    const source = path.join(directory, "source");
    if (kind === "file") await fs.writeFile(source, "source");
    else if (kind === "directory") await fs.mkdir(source);
    else await fs.symlink("opaque", source);
    const parent = { path: directory, identity: await fs.lstat(directory, { bigint: true }) };
    const before = await fs.lstat(source, { bigint: true });
    using owner = retainEntryForPublication({
      source: { parent, basename: "source", expected: { ...before, kind } },
      destination: { parent, basename: "target" }, assertBeforeMutation() {},
    });
    expect(owner.publish()).toMatchObject({ transition: "not-published", issues: [{ phase: "native", cause: expected }] });
    expect(await fs.lstat(source, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
    expect(await fs.readdir(directory)).toEqual(["source"]);
  });

  it("cleans a retained symlink after explicit unsupported-capability rejection", async () => {
    __setNativeLoaderForTest(() => ({ ...native!, publishStagedSymlink: fail }));
    const directory = await tempRoot("fs-safe-noreplace-symlink-");
    await fs.symlink("opaque", path.join(directory, "stage"));
    const stat = await fs.lstat(path.join(directory, "stage"), { bigint: true });
    const owner = await retainSymlinkInDirectory({ directory, basename: "stage", assertBeforeMutation() {},
      expected: { ...stat, uid: Number(stat.uid), gid: Number(stat.gid), target: "opaque" },
    });
    await expect(owner.publish("target")).rejects.toMatchObject(expected);
    expect(await owner.cleanup()).toMatchObject({ status: "removed", publication: { status: "not-published" } });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["auto", "require", "require-bounded"] as const)("settles unsupported workspace quarantine in %s", async mode => {
    configureFsSafeNative({ mode: mode === "require" ? "require" : "auto" });
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: fail, ownedTreeRemovalAvailable: () => true }));
    const directory = await tempRoot("fs-safe-noreplace-workspace-");
    const workspace = await tempWorkspace({ rootDir: directory, prefix: "test-", cleanupSafety: mode === "require-bounded" ? "require-bounded" : "compatible" });
    if (mode === "auto") {
      expect(await workspace.cleanup()).toBe("removed");
      expect(await fs.readdir(directory)).toEqual([]);
    } else {
      await expect(workspace.cleanup()).rejects.toMatchObject(expected);
      expect(await fs.readdir(directory)).toHaveLength(1);
    }
  });
});
