import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root, type RootCopyPublicationReceipt } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { probeTreeClone, readCloneFileMetadata } from "../src/clone.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture(content: string | Buffer = "complete source bytes") {
  const directory = await tempRoot("fs-safe-copy-options-");
  const sourceDirectory = path.join(directory, "source");
  const destinationDirectory = path.join(directory, "destination");
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(destinationDirectory);
  const sourcePath = path.join(sourceDirectory, "input");
  const target = path.join(destinationDirectory, "target");
  await fs.writeFile(sourcePath, content);
  return {
    directory, sourceDirectory, destinationDirectory, sourcePath, target, content,
    source: await root(sourceDirectory),
    destination: await root(destinationDirectory),
  };
}

function afterFirstSourceRead(sourcePath: string, afterRead: () => Promise<void> | void) {
  __setFsSafeTestHooksForTest({
    afterOpen(candidate, handle) {
      if (candidate !== sourcePath) return;
      const read = handle.read.bind(handle);
      let first = true;
      vi.spyOn(handle, "read").mockImplementation(async (...args) => {
        const result = await read(...args);
        if (first) {
          first = false;
          await afterRead();
        }
        return result;
      });
    },
  });
}

describe("Root.copyIn source and clone options", () => {
  it.each((["path", "root"] as const).flatMap(source =>
    (["never", "auto"] as const).map(clone => ({ source, clone }))))(
    "copies all $source bytes independently of source offset with clone=$clone and native off",
    async ({ source, clone }) => {
      const pattern = Buffer.from(Array.from({ length: 251 }, (_, index) => index));
      const content = Buffer.alloc(256 * 1024 + 31).fill(pattern);
      const copy = await fixture(content);
      await fs.writeFile(copy.target, "previous target");
      let admitted: FileHandle | undefined;
      __setFsSafeTestHooksForTest({
        async afterOpen(candidate, handle) {
          if (candidate !== copy.sourcePath) return;
          admitted = handle;
          await handle.read(Buffer.alloc(31), 0, 31, null);
        },
      });

      await copy.destination.copyIn("target", source === "path" ? copy.sourcePath : {
        root: copy.source, relativePath: "input",
      }, { clone, mode: 0o640 });

      expect(admitted?.fd).toBe(-1);
      expect((await fs.readFile(copy.target)).equals(content)).toBe(true);
      if (process.platform !== "win32") expect((await fs.stat(copy.target)).mode & 0o777).toBe(0o640);
      await fs.writeFile(copy.target, "independent destination");
      expect((await fs.readFile(copy.sourcePath)).equals(content)).toBe(true);
      expect(await fs.readdir(copy.destinationDirectory)).toEqual(["target"]);
    },
  );

  it("fails required cloning without native support before creating the destination", async () => {
    const copy = await fixture();
    await expect(copy.destination.copyIn("nested/target", {
      root: copy.source, relativePath: "input",
    }, { clone: "require", mkdir: true })).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
    expect(await fs.readFile(copy.sourcePath, "utf8")).toBe(copy.content);
  });

  it.skipIf(process.platform === "win32").each([
    { mode: undefined, defaultMode: undefined, expected: 0o751 },
    { mode: undefined, defaultMode: 0o640, expected: 0o640 },
    { mode: 0o600, defaultMode: 0o640, expected: 0o600 },
  ])("selects admitted source mode with numeric mode precedence ($mode/$defaultMode)", async ({ mode, defaultMode, expected }) => {
    const copy = await fixture();
    await fs.chmod(copy.sourcePath, 0o751);
    const destination = await root(copy.destinationDirectory, { mode: defaultMode });
    await destination.copyIn("target", { root: copy.source, relativePath: "input" }, {
      preserveSourceMode: true, mode,
    });
    expect((await fs.stat(copy.target)).mode & 0o7777).toBe(expected);
    expect(await fs.readFile(copy.target, "utf8")).toBe(copy.content);
  });

  it("rejects traversal outside the source capability", async () => {
    const copy = await fixture();
    await fs.writeFile(path.join(copy.directory, "outside"), "outside bytes");
    await expect(copy.destination.copyIn("target", {
      root: copy.source, relativePath: "../outside",
    })).rejects.toMatchObject({ code: "outside-workspace" });
    expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
  });

  it.each([
    { sourcePolicy: "allow", override: undefined, allowed: true },
    { sourcePolicy: "allow", override: "reject", allowed: false },
    { sourcePolicy: "reject", override: "allow", allowed: true },
  ] as const)("honors source hardlink policy $sourcePolicy with override $override", async ({ sourcePolicy, override, allowed }) => {
    const copy = await fixture();
    const alias = path.join(copy.sourceDirectory, "alias");
    await fs.link(copy.sourcePath, alias);
    const source = await root(copy.sourceDirectory, { hardlinks: sourcePolicy });
    const pending = copy.destination.copyIn("target", { root: source, relativePath: "input" }, {
      sourceHardlinks: override,
    });
    if (allowed) {
      await expect(pending).resolves.toBeUndefined();
      expect(await fs.readFile(copy.target, "utf8")).toBe(copy.content);
      await fs.writeFile(copy.target, "independent copy");
    } else {
      await expect(pending).rejects.toMatchObject({ code: "hardlink" });
      expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
    }
    expect(await fs.readFile(copy.sourcePath, "utf8")).toBe(copy.content);
    expect(await fs.readFile(alias, "utf8")).toBe(copy.content);
  });

  it.skipIf(process.platform === "win32").each(["reject", "follow-within-root"] as const)(
    "honors the guarded source's %s symlink policy",
    async symlinks => {
      const copy = await fixture();
      await fs.symlink("input", path.join(copy.sourceDirectory, "alias"));
      await fs.symlink(copy.target, path.join(copy.sourceDirectory, "outside"));
      await fs.writeFile(copy.target, "outside bytes");
      const source = await root(copy.sourceDirectory, { symlinks });
      const pending = copy.destination.copyIn("inside", { root: source, relativePath: "alias" });
      if (symlinks === "reject") {
        await expect(pending).rejects.toMatchObject({ code: "symlink" });
      } else {
        await expect(pending).resolves.toBeUndefined();
        expect(await fs.readFile(path.join(copy.destinationDirectory, "inside"), "utf8")).toBe(copy.content);
      }
      await expect(copy.destination.copyIn("escape", {
        root: source, relativePath: "outside",
      })).rejects.toBeTruthy();
      await expect(fs.lstat(path.join(copy.destinationDirectory, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("Root.copyIn exclusive publication", () => {
  it.each(["existing read-only file", "existing unreadable file", "competing writer"] as const)(
    "preserves an %s without publishing a receipt",
    async outcome => {
      const copy = await fixture();
      const onDestinationPublished = vi.fn();
      let competitorCreated = false;
      if (outcome !== "competing writer") {
        await fs.writeFile(copy.target, "winner", { mode: outcome === "existing unreadable file" ? 0 : 0o400 });
      } else {
        afterFirstSourceRead(copy.sourcePath, async () => {
          expect(fsSync.existsSync(copy.target)).toBe(false);
          await fs.writeFile(copy.target, "winner", { flag: "wx" });
          competitorCreated = true;
        });
      }
      const before = outcome !== "competing writer" ? await fs.stat(copy.target, { bigint: true }) : undefined;
      try {
        await expect(copy.destination.copyIn("target", {
          root: copy.source, relativePath: "input",
        }, { overwrite: false, onDestinationPublished })).rejects.toMatchObject({ code: "already-exists" });
        if (before) {
          const after = await fs.stat(copy.target, { bigint: true });
          expect({ ino: after.ino, dev: after.dev, mode: after.mode }).toEqual({
            ino: before.ino, dev: before.dev, mode: before.mode,
          });
        } else expect(competitorCreated).toBe(true);
        await fs.chmod(copy.target, 0o600);
        expect(await fs.readFile(copy.target, "utf8")).toBe("winner");
        expect(onDestinationPublished).not.toHaveBeenCalled();
        expect(await fs.readFile(copy.sourcePath, "utf8")).toBe(copy.content);
        expect(await fs.readdir(copy.destinationDirectory)).toEqual(["target"]);
      } finally {
        await fs.chmod(copy.target, 0o600);
      }
    },
  );

  it("enforces the byte limit when the admitted source grows during copying", async () => {
    const copy = await fixture("1234");
    let grew = false;
    afterFirstSourceRead(copy.sourcePath, async () => {
      expect(fsSync.existsSync(copy.target)).toBe(false);
      await fs.appendFile(copy.sourcePath, "56789");
      grew = true;
    });
    const onDestinationPublished = vi.fn();
    await expect(copy.destination.copyIn("target", {
      root: copy.source, relativePath: "input",
    }, { overwrite: false, maxBytes: 4, onDestinationPublished })).rejects.toMatchObject({ code: "too-large" });
    expect(grew).toBe(true);
    expect(onDestinationPublished).not.toHaveBeenCalled();
    expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
    expect(await fs.readFile(copy.sourcePath, "utf8")).toBe("123456789");
  });

  it("settles an admitted read before completing cancellation and private-stage cleanup", async () => {
    const copy = await fixture(Buffer.alloc(128 * 1024, 0x5a));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const canceled = new Error("copy canceled");
    const onDestinationPublished = vi.fn();
    afterFirstSourceRead(copy.sourcePath, async () => {
      started.resolve();
      await release.promise;
    });
    let settled = false;
    const pending = copy.destination.copyIn("target", {
      root: copy.source, relativePath: "input",
    }, { overwrite: false, signal: controller.signal, onDestinationPublished }).then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; },
    );
    await started.promise;
    try {
      controller.abort(canceled);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(fsSync.existsSync(copy.target)).toBe(false);
    } finally {
      release.resolve();
    }
    expect(await pending).toBe(canceled);
    expect(onDestinationPublished).not.toHaveBeenCalled();
    expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
    expect(await fs.readFile(copy.sourcePath)).toEqual(copy.content);
  });

  it("rejects pre-aborted copies before creating a destination parent", async () => {
    const copy = await fixture();
    const reason = new Error("already canceled");
    await expect(copy.destination.copyIn("new/target", copy.sourcePath, {
      signal: AbortSignal.abort(reason),
    })).rejects.toBe(reason);
    expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
  });

  it("rejects an asynchronous publication observer while retaining its completed copy", async () => {
    const copy = await fixture();
    await expect(copy.destination.copyIn("target", copy.sourcePath, {
      overwrite: false,
      onDestinationPublished: async () => { throw new Error("asynchronous observer rejected"); },
    })).rejects.toThrow("onDestinationPublished must be synchronous");
    expect(await fs.readFile(copy.target, "utf8")).toBe(copy.content);
    expect(await fs.readdir(copy.destinationDirectory)).toEqual(["target"]);
  });

  it("rechecks caller authority after asynchronous source reads", async () => {
    const copy = await fixture();
    const expired = Object.assign(new Error("copy owner expired"), { code: "EPERM" });
    let active = true;
    let revoked = false;
    afterFirstSourceRead(copy.sourcePath, () => { active = false; revoked = true; });
    const onDestinationPublished = vi.fn();
    await expect(copy.destination.copyIn("target", {
      root: copy.source, relativePath: "input",
    }, {
      overwrite: false,
      assertBeforeMutation: () => { if (!active) throw expired; },
      onDestinationPublished,
    })).rejects.toBe(expired);
    expect(revoked).toBe(true);
    expect(onDestinationPublished).not.toHaveBeenCalled();
    expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
    expect(await fs.readFile(copy.sourcePath, "utf8")).toBe(copy.content);
  });

  it.each([false, true].flatMap(overwrite =>
    ["observer", "verification"].map(failure => ({ overwrite, failure } as const))))(
    "retains the synchronous receipt and committed target after $failure failure (overwrite=$overwrite)",
    async ({ overwrite, failure }) => {
      const copy = await fixture();
      if (overwrite) await fs.writeFile(copy.target, "previous target");
      const failed = new Error("failure after publication");
      const receipts: RootCopyPublicationReceipt[] = [];
      __setFsSafeTestHooksForTest({
        afterPinnedWriteFallbackRename(candidate) {
          if (candidate !== copy.target) return;
          expect(receipts).toHaveLength(1);
          if (failure === "verification") throw failed;
        },
      });
      const options = {
        overwrite,
        onDestinationPublished(receipt: RootCopyPublicationReceipt) {
          const published = fsSync.lstatSync(copy.target, { bigint: true });
          expect(receipt).toEqual({ path: copy.target, dev: published.dev, ino: published.ino });
          expect(fsSync.readFileSync(copy.target, "utf8")).toBe(copy.content);
          receipts.push(receipt);
          if (failure === "observer") throw failed;
        },
      };
      const pending = copy.destination.copyIn("target", {
        root: copy.source, relativePath: "input",
      }, options);
      options.onDestinationPublished = () => { throw new Error("successor observer must not run"); };
      if (failure === "observer") await expect(pending).rejects.toBe(failed);
      else await expect(pending).rejects.toMatchObject({ cause: failed });
      expect(receipts).toHaveLength(1);
      expect(await fs.readFile(copy.target, "utf8")).toBe(copy.content);
      expect(await fs.readFile(copy.sourcePath, "utf8")).toBe(copy.content);
      expect(await fs.readdir(copy.destinationDirectory)).toEqual(["target"]);
    },
  );
});

describe.skipIf(!nativeAvailable)("Root.copyIn native transfer", () => {
  it.runIf(process.platform === "win32")("refuses required file cloning with the Windows binding before destination creation", async () => {
    configureFsSafeNative({ mode: "require" });
    const copy = await fixture();
    await expect(copy.destination.copyIn("nested/target", copy.sourcePath, {
      clone: "require", overwrite: false,
    })).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
    expect(await fs.readFile(copy.sourcePath, "utf8")).toBe(copy.content);
  });

  it.each(["never", "auto"] as const)("copies complete independent bytes with clone=%s", async clone => {
    configureFsSafeNative({ mode: "require" });
    const copy = await fixture(Buffer.alloc(128 * 1024 + 1, 0x5a));
    __setFsSafeTestHooksForTest({
      async afterOpen(candidate, handle) {
        if (candidate === copy.sourcePath) await handle.read(Buffer.alloc(31), 0, 31, null);
      },
    });
    await copy.destination.copyIn("target", {
      root: copy.source, relativePath: "input",
    }, { overwrite: false, clone });
    expect(await fs.readFile(copy.target)).toEqual(copy.content);
    await fs.writeFile(copy.target, "independent destination");
    expect(await fs.readFile(copy.sourcePath)).toEqual(copy.content);
    expect(await fs.readdir(copy.destinationDirectory)).toEqual(["target"]);
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "requires cloning exactly when the source and destination filesystem support it",
    async () => {
      configureFsSafeNative({ mode: "require" });
      const copy = await fixture(Buffer.alloc(128 * 1024 + 1, 0x5a));
      const probe = path.join(copy.destinationDirectory, "clone-probe");
      const supported = process.platform === "darwin" ? probeTreeClone(copy.destinationDirectory) === "apfs"
        : await fs.copyFile(copy.sourcePath, probe, fsSync.constants.COPYFILE_FICLONE_FORCE).then(
        () => true,
        error => {
          expect(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"]).toContain(error.code);
          return false;
        },
      );
      await fs.rm(probe, { force: true });
      const pending = copy.destination.copyIn("target", {
        root: copy.source, relativePath: "input",
      }, { overwrite: false, clone: "require" });
      if (supported) {
        await expect(pending).resolves.toBeUndefined();
        expect(await fs.readFile(copy.target)).toEqual(copy.content);
        if (process.platform === "darwin") {
          const [sourceMetadata, targetMetadata] = await readCloneFileMetadata([copy.sourcePath, copy.target]);
          expect(sourceMetadata?.cloneId).toBeTruthy();
          expect(targetMetadata?.cloneId).toBe(sourceMetadata?.cloneId);
        }
        await fs.writeFile(copy.target, "independent destination");
        expect(await fs.readFile(copy.sourcePath)).toEqual(copy.content);
      } else {
        await expect(pending).rejects.toMatchObject({ code: "unsupported-platform" });
        expect(await fs.readdir(copy.destinationDirectory)).toEqual([]);
      }
    },
  );
});
