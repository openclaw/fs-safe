import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, describe, expect, it, type TestContext } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { copyTree, createCloneSource, probeTreeClone, readCloneFileMetadata } from "../src/copy.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  getNativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempDirs, tempRoot } = useRealTempDirs();
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

async function cloneFixture(context: TestContext) {
  const explicitParent = process.env.FS_SAFE_CLONE_TEST_ROOT;
  const parent = await fs.realpath(explicitParent ?? os.tmpdir());
  const backend = probeTreeClone(parent);
  if (!backend) {
    if (explicitParent) throw new Error("FS_SAFE_CLONE_TEST_ROOT requires native clone support");
    context.skip("native APFS, Btrfs, ReFS, or XFS volume unavailable");
    throw new Error("unreachable");
  }
  const directory = await fs.mkdtemp(path.join(parent, "fs-safe-clone-"));
  tempDirs.push(directory);
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination-é space");
  await createCloneSource(source);
  return { directory, source, destination, backend };
}

describe("native directory cloning", () => {
  it("does not create probe artifacts or silently copy when native support is disabled", async () => {
    const directory = await tempRoot("fs-safe-clone-disabled-");
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "payload"), "original");
    configureFsSafeNative({ mode: "off" });
    expect(probeTreeClone(directory)).toBeUndefined();
    await expect(createCloneSource(destination)).rejects.toThrow();
    await expect(copyTree(source, destination, { clone: "always" })).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual(["source"]);
    expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("original");
  });

  it("honors an already aborted signal without creating a source or clone", async () => {
    const directory = await tempRoot("fs-safe-clone-aborted-");
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source);
    const signal = AbortSignal.abort(new Error("caller canceled cloning"));
    await expect(createCloneSource(destination, { signal })).rejects.toThrow("caller canceled");
    await expect(copyTree(source, destination, { clone: "always", signal })).rejects.toThrow(
      "caller canceled",
    );
    expect(await fs.readdir(directory)).toEqual(["source"]);
  });

  it("keeps unsupported filesystems on the caller's fallback path", async (context) => {
    const directory = await tempRoot("fs-safe-clone-unsupported-");
    if (!getNativeBinding() || probeTreeClone(directory)) {
      context.skip("requires native binding and an unsupported temporary filesystem");
      return;
    }
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "payload"), "original");
    await expect(copyTree(source, destination, { clone: "always" })).rejects.toThrow();
    await expect(createCloneSource(destination)).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual(["source"]);
  });

  it.each([0, -1, 1.5, 33, NaN, Infinity])(
    "rejects invalid concurrency %s before creating a destination",
    async (concurrency) => {
      const directory = await tempRoot("fs-safe-clone-options-");
      const source = path.join(directory, "source");
      const destination = path.join(directory, "destination");
      await fs.mkdir(source);
      await expect(
        copyTree(source, destination, { clone: "always", concurrency }),
      ).rejects.toThrow();
      expect(await fs.readdir(directory)).toEqual(["source"]);
    },
  );

  it("joins admitted native writes and retains their descriptors before rejecting cancellation", async (context) => {
    const binding = getNativeBinding();
    if (!binding) {
      context.skip("native binding unavailable");
      return;
    }
    const directory = await tempRoot("fs-safe-clone-settlement-");
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    __setNativeLoaderForTest(() => ({
      ...binding,
      probeTreeClone: () => "apfs",
      async cloneTree(sourceFd, parentFd) {
        entered.resolve();
        await release.promise;
        expect(sourceFd).not.toBeNull();
        expect(fsSync.fstatSync(sourceFd!).isDirectory()).toBe(true);
        expect(fsSync.fstatSync(parentFd).isDirectory()).toBe(true);
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "complete"), "settled");
      },
    }));
    const controller = new AbortController();
    let settled = false;
    const pending = copyTree(source, destination, {
      clone: "always",
      signal: controller.signal,
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const reason = new Error("cancel while native work is running");
    try {
      await Promise.race([
        entered.promise,
        pending.then((error) => {
          throw error;
        }),
      ]);
      controller.abort(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      expect(await pending).toBe(reason);
      expect(await fs.readFile(path.join(destination, "complete"), "utf8")).toBe("settled");
    } finally {
      release.resolve();
      await pending;
    }
  });

  it.for([
    { label: "one worker", concurrency: 1 },
    { label: "default workers", concurrency: undefined },
  ])(
    "preserves tree data and metadata with $label and independent writes",
    async ({ concurrency }, context) => {
      const { source, destination } = await cloneFixture(context);
      await fs.mkdir(path.join(source, "nested"));
      await fs.mkdir(path.join(source, "empty-directory"));
      const payload = Buffer.alloc(1024 * 1024, 0x5a);
      const contents = new Map([
        ["empty", Buffer.alloc(0)],
        ["short", Buffer.from("unaligned payload")],
        ["日本語-🦀", Buffer.alloc(4097, 0x37)],
        [path.join("nested", ".payload"), payload],
      ]);
      for (const [name, bytes] of contents) {
        await fs.writeFile(path.join(source, name), bytes);
        await fs.utimes(path.join(source, name), 1_600_000_000, 1_600_000_000);
      }
      const original = path.join(source, "nested", ".payload");
      const cloned = path.join(destination, "nested", ".payload");
      if (process.platform !== "win32") {
        await fs.chmod(original, 0o751);
        await fs.chmod(path.join(source, "nested"), 0o750);
      }
      const directories = ["", "nested", "empty-directory"];
      for (const name of directories) {
        await fs.utimes(path.join(source, name), 1_600_000_000, 1_600_000_000);
      }
      const controller = new AbortController();
      let callerAborts = 0;
      controller.signal.onabort = () => {
        callerAborts++;
      };
      await copyTree(source, destination, {
        clone: "always",
        concurrency,
        signal: controller.signal,
      });
      controller.abort();
      expect(callerAborts).toBe(1);
      for (const [name, bytes] of contents) {
        expect((await fs.readFile(path.join(destination, name))).equals(bytes), name).toBe(true);
        expect((await fs.stat(path.join(destination, name))).mtimeMs).toBe(1_600_000_000_000);
      }
      for (const name of directories) {
        expect((await fs.stat(path.join(destination, name))).mtimeMs, name).toBe(1_600_000_000_000);
      }
      expect(await fs.readdir(path.join(destination, "empty-directory"))).toEqual([]);
      if (process.platform !== "win32") {
        expect((await fs.stat(cloned)).mode & 0o777).toBe(0o751);
        expect((await fs.stat(path.join(destination, "nested"))).mode & 0o777).toBe(0o750);
      }
      await fs.writeFile(cloned, "independent edit");
      expect((await fs.readFile(original)).equals(payload)).toBe(true);
      await expect(copyTree(source, destination, { clone: "always" })).rejects.toThrow();
      await expect(createCloneSource(destination)).rejects.toThrow();
      expect(await fs.readFile(cloned, "utf8")).toBe("independent edit");
      expect(await fs.readdir(destination)).not.toContain("source");
    },
  );

  it("preserves literal symlinks and refuses a symlink as the clone source", async (context) => {
    const { directory, source, destination } = await cloneFixture(context);
    await fs.writeFile(path.join(source, "payload"), "original");
    try {
      await fs.symlink("payload", path.join(source, "link"), "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        context.skip("Windows symlink creation requires Developer Mode or privilege");
      }
      throw error;
    }
    await fs.symlink("missing-target", path.join(source, "dangling"), "file");
    const outside = path.join(directory, "outside");
    const outsideTarget = path.join("..", "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "payload"), "outside contents");
    await fs.utimes(outside, 1_600_000_000, 1_600_000_000);
    await fs.symlink(outsideTarget, path.join(source, "directory-link"), "dir");
    const outsideBefore = await fs.stat(outside, { bigint: true });
    await copyTree(source, destination, { clone: "always" });
    expect(await fs.readlink(path.join(destination, "link"))).toBe("payload");
    expect(await fs.readlink(path.join(destination, "dangling"))).toBe("missing-target");
    expect(await fs.readlink(path.join(destination, "directory-link"))).toBe(outsideTarget);
    const outsideAfter = await fs.stat(outside, { bigint: true });
    expect(outsideAfter.mtimeNs).toBe(1_600_000_000_000_000_000n);
    // Reapplying an equal mtime still changes ctime if traversal follows this link.
    expect(outsideAfter.ctimeNs).toBe(outsideBefore.ctimeNs);
    expect(await fs.readdir(outside)).toEqual(["payload"]);
    expect(await fs.readFile(path.join(outside, "payload"), "utf8")).toBe("outside contents");
    await fs.writeFile(path.join(destination, "payload"), "clone edit");
    expect(await fs.readFile(path.join(destination, "link"), "utf8")).toBe("clone edit");
    expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("original");
    const alias = path.join(directory, "source-alias");
    await fs.symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(
      copyTree(alias, path.join(directory, "alias-clone"), { clone: "always" }),
    ).rejects.toThrow();
    await expect(fs.access(path.join(directory, "alias-clone"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires a Btrfs subvolume source instead of copying an ordinary directory", async (context) => {
    const { directory, destination, backend } = await cloneFixture(context);
    if (backend !== "btrfs") context.skip("Btrfs-specific source requirement");
    const ordinary = path.join(directory, "ordinary");
    await fs.mkdir(ordinary);
    await fs.writeFile(path.join(ordinary, "payload"), "original");
    await expect(copyTree(ordinary, destination, { clone: "always" })).rejects.toThrow();
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(ordinary, "payload"), "utf8")).toBe("original");
  });

  it("rejects ReFS alternate streams without reporting a lossy clone as success", async (context) => {
    const { source, destination, backend } = await cloneFixture(context);
    if (backend !== "refs") context.skip("ReFS-specific stream preservation");
    const original = path.join(source, "payload");
    await fs.writeFile(original, "main data");
    await fs.writeFile(`${original}:metadata`, "named stream data");
    await expect(copyTree(source, destination, { clone: "always" })).rejects.toThrow();
    expect(await fs.readFile(original, "utf8")).toBe("main data");
    expect(await fs.readFile(`${original}:metadata`, "utf8")).toBe("named stream data");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a failed XFS clone without altering its source and permits retry", async (context) => {
    const { source, destination, backend } = await cloneFixture(context);
    if (backend !== "xfs") context.skip("XFS-specific partial clone cleanup");
    const readonly = path.join(source, "readonly");
    const copiedReadonly = path.join(destination, "readonly");
    await fs.mkdir(readonly);
    await fs.writeFile(path.join(readonly, "payload"), "read-only directory contents");
    const nested = path.join(source, "nested");
    const fifo = path.join(nested, "unsupported-fifo");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(source, "payload"), "original");
    execFileSync("mkfifo", [fifo]);
    await fs.chmod(readonly, 0o555);
    try {
      await expect(copyTree(source, destination, { clone: "always" })).rejects.toThrow();
      expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
      expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("original");
      expect((await fs.stat(readonly)).mode & 0o777).toBe(0o555);
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.unlink(fifo);
      await copyTree(source, destination, { clone: "always" });
      expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe("original");
      expect(await fs.readdir(path.join(destination, "nested"))).toEqual([]);
      expect(await fs.readFile(path.join(copiedReadonly, "payload"), "utf8")).toBe(
        "read-only directory contents",
      );
      expect((await fs.stat(copiedReadonly)).mode & 0o777).toBe(0o555);
    } finally {
      await fs.chmod(readonly, 0o755);
      await fs.chmod(copiedReadonly, 0o755).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
  });

  it("preserves XFS file and directory extended attributes and ACLs", async (context) => {
    const { source, destination, backend } = await cloneFixture(context);
    if (backend !== "xfs") context.skip("XFS-specific extended metadata");
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested", "payload"), "original");
    const entries = ["", "nested", path.join("nested", "payload")];
    for (const name of entries) {
      const original = path.join(source, name);
      execFileSync("setfattr", ["-n", "user.fs-safe-clone", "-v", `metadata:${name}`, original]);
      execFileSync("setfacl", [
        "-m",
        name === path.join("nested", "payload") ? "u:65534:r--" : "u:65534:r-x,d:u:65534:r-x",
        original,
      ]);
    }

    await copyTree(source, destination, { clone: "always" });
    for (const name of entries) {
      const cloned = path.join(destination, name);
      expect(
        execFileSync("getfattr", ["--only-values", "-n", "user.fs-safe-clone", cloned], {
          encoding: "utf8",
        }),
      ).toBe(`metadata:${name}`);
      const aclOptions = ["--omit-header", "--numeric", "--absolute-names"];
      expect(execFileSync("getfacl", [...aclOptions, cloned], { encoding: "utf8" })).toBe(
        execFileSync("getfacl", [...aclOptions, path.join(source, name)], { encoding: "utf8" }),
      );
    }
    expect(await fs.readFile(path.join(destination, "nested", "payload"), "utf8")).toBe("original");
  });

  it("rejects cloning a tree into itself or its descendants", async (context) => {
    const { source } = await cloneFixture(context);
    await fs.writeFile(path.join(source, "payload"), "original");
    await expect(copyTree(source, source, { clone: "always" })).rejects.toThrow();
    await expect(
      copyTree(source, path.join(source, "child"), { clone: "always" }),
    ).rejects.toThrow();
    expect(await fs.readdir(source)).toEqual(["payload"]);
  });

  it("reports APFS clone provenance and stops matching after an independent edit", async (context) => {
    const { source, destination, backend } = await cloneFixture(context);
    if (backend !== "apfs") context.skip("APFS clone provenance");
    const original = path.join(source, "payload");
    const cloned = path.join(destination, "payload");
    await fs.writeFile(original, Buffer.alloc(1024 * 1024, 0x5a));
    await fs.symlink("payload", path.join(source, "link"));
    await copyTree(source, destination, { clone: "always" });
    const [originalMetadata, clonedMetadata, linkMetadata, missingMetadata] =
      await readCloneFileMetadata([
        original,
        cloned,
        path.join(destination, "link"),
        path.join(destination, "missing"),
      ]);
    assert(originalMetadata);
    assert(clonedMetadata);
    expect(originalMetadata.cloneId).not.toBe(0n);
    expect(clonedMetadata.cloneId).toBe(originalMetadata.cloneId);
    expect(clonedMetadata.ino).not.toBe(originalMetadata.ino);
    const stat = await fs.lstat(cloned, { bigint: true });
    expect(clonedMetadata.ino).toBe(stat.ino);
    expect(clonedMetadata.size).toBe(stat.size);
    expect(BigInt(clonedMetadata.mtimeSec) * 1_000_000_000n + BigInt(clonedMetadata.mtimeNs)).toBe(
      stat.mtimeNs,
    );
    expect(BigInt(clonedMetadata.ctimeSec) * 1_000_000_000n + BigInt(clonedMetadata.ctimeNs)).toBe(
      stat.ctimeNs,
    );
    expect(linkMetadata?.type).not.toBe(1);
    expect(missingMetadata).toBeUndefined();
    await fs.writeFile(cloned, "independent edit");
    const [afterSource, afterClone] = await readCloneFileMetadata([original, cloned]);
    assert(afterSource);
    assert(afterClone);
    expect(afterClone.cloneId).not.toBe(afterSource.cloneId);
    expect((await fs.readFile(original)).equals(Buffer.alloc(1024 * 1024, 0x5a))).toBe(true);
  });
});
