import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageFileInDirectory, type StagedFile, type StagedFileCleanupReceipt } from "../src/advanced.js";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, root, type RootCopyPublicationReceipt } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding,
} from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { rejection, assertWrapped, hostileErrors } from "./helpers/staged-errors.js";

const posix = process.platform === "linux" || process.platform === "darwin";
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function descriptorCount(): number | undefined {
  return posix ? fsSync.readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length : undefined;
}

describe.each(["off", "require"] as const)("Root.copyIn hostile publication errors with native %s", nativeMode => {
  it.skipIf(nativeMode === "require" && !native).each(
    hostileErrors.flatMap(error => [false, true].map(overwrite => ({ ...error, overwrite }))),
  )("preserves $label and the published destination (overwrite=$overwrite)", async ({ create, overwrite }) => {
    configureFsSafeNative({ mode: nativeMode });
    const directory = await tempRoot("fs-safe-copy-hostile-observer-");
    const sourceDirectory = path.join(directory, "source");
    const destinationDirectory = path.join(directory, "destination");
    await fs.mkdir(sourceDirectory);
    await fs.mkdir(destinationDirectory, { mode: 0o700 });
    const sourcePath = path.join(sourceDirectory, "input");
    const target = path.join(destinationDirectory, "target");
    await fs.writeFile(sourcePath, "complete source bytes");
    if (overwrite) await fs.writeFile(target, "previous target");
    const source = await root(sourceDirectory);
    const destination = await root(destinationDirectory);
    const failure = create();
    const receipts: RootCopyPublicationReceipt[] = [];
    const handles: FileHandle[] = [];
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      handles.push(handle);
      return handle;
    });
    __setFsSafeTestHooksForTest({ afterOpen(_candidate, handle) { handles.push(handle); } });
    const before = descriptorCount();
    // Vitest mocks inspect thrown prototypes, so use a plain observer.
    const result = await rejection(destination.copyIn("target", { root: source, relativePath: "input" }, {
      overwrite,
      onDestinationPublished(receipt) {
        receipts.push(receipt);
        throw failure;
      },
    }));
    expect(result.error === failure).toBe(true);
    expect(receipts).toHaveLength(1);
    const published = await fs.stat(target, { bigint: true });
    expect(receipts[0]).toEqual({ path: target, dev: published.dev, ino: published.ino });
    expect(Object.isFrozen(receipts[0])).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("complete source bytes");
    expect(await fs.readFile(sourcePath, "utf8")).toBe("complete source bytes");
    expect(await fs.readdir(destinationDirectory)).toEqual(["target"]);
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.every(handle => handle.fd === -1)).toBe(true);
    expect(descriptorCount()).toBe(before);
  });
});

type Fault = "remove" | "file-close" | "parent-close";

async function nativeFixture(fault?: Fault, cause?: unknown) {
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("fs-safe-stage-hostile-error-");
  const calls = { remove: 0, fileClose: 0, parentClose: 0, rename: 0 };
  let parentFd = -1, fileFd = -1;
  let armed = true;
  const closeParent = fsSync.closeSync;
  const binding: NativeBinding = {
    ...native!,
    createStagedFile(...args) {
      parentFd = args[0];
      return fileFd = native!.createStagedFile!(...args);
    },
    removeStagedFile(...args) {
      calls.remove += 1;
      if (armed && fault === "remove") throw cause;
      return native!.removeStagedFile!(...args);
    },
    closeOwnedFd(fd) {
      if (fd === fileFd) calls.fileClose += 1;
      native!.closeOwnedFd(fd);
      if (armed && fault === "file-close" && fd === fileFd) throw cause;
    },
  };
  __setNativeLoaderForTest(() => binding);
  // Admission captures the closer. Throw only after consuming the descriptor.
  fsSync.closeSync = (fd) => {
    if (fd === parentFd) calls.parentClose += 1;
    closeParent(fd);
    if (armed && fault === "parent-close" && fd === parentFd) throw cause;
  };
  let owner: StagedFile;
  try { owner = await stageFileInDirectory({ directory, content: "owned bytes" }); }
  catch (error) { fsSync.closeSync = closeParent; throw error; }
  return {
    directory, owner, binding, calls,
    disarm() { armed = false; },
    assertClosedOnce() {
      expect(calls.fileClose).toBe(1);
      expect(calls.parentClose).toBe(1);
      expect(() => fsSync.fstatSync(fileFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(() => fsSync.fstatSync(parentFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    },
    async finish() {
      armed = false;
      try { await owner.cleanup().catch(() => {}); }
      finally { fsSync.closeSync = closeParent; }
    },
  };
}

describe.runIf(posix && !!native)("staged file hostile error settlement", () => {
  it.each(hostileErrors.flatMap(error =>
    (["remove", "file-close", "parent-close"] as const).map(fault => ({ ...error, fault })),
  ))("caches $label from $fault after closing every resource", async ({ create, fault }) => {
    const cause = create();
    const item = await nativeFixture(fault, cause);
    const temporary = path.join(item.directory, item.owner.receipt.temporaryBasename);
    try {
      const first = await rejection(item.owner.cleanup());
      const error = assertWrapped(first.error, cause);
      expect(error.details?.phase).toBe("cleanup");
      expect(error.details?.cleanup).toEqual({
        temporaryBasename: item.owner.receipt.temporaryBasename,
        publication: { status: "not-published" },
        status: fault === "remove" ? "failed" : "removed",
        resources: fault === "remove" ? "closed" : "close-failed",
      });
      expect(Object.isFrozen(error.details?.cleanup)).toBe(true);
      item.assertClosedOnce();
      expect(item.calls.remove).toBe(1);
      if (fault === "remove") {
        expect(await fs.readFile(temporary, "utf8")).toBe("owned bytes");
        await fs.rename(temporary, path.join(item.directory, "original"));
      }
      await fs.writeFile(temporary, "foreign replacement");
      item.disarm();
      const unrelated = await fs.open(path.join(item.directory, "unrelated"), "w+");
      try {
        expect((await rejection(item.owner.cleanup())).error === error).toBe(true);
        expect((await rejection(item.owner[Symbol.asyncDispose]())).error === error).toBe(true);
        expect(item.calls).toEqual({ remove: 1, fileClose: 1, parentClose: 1, rename: 0 });
        await unrelated.writeFile("still open");
        expect(await fs.readFile(path.join(item.directory, "unrelated"), "utf8")).toBe("still open");
        expect(await fs.readFile(temporary, "utf8")).toBe("foreign replacement");
        if (fault === "remove") expect(await fs.readFile(path.join(item.directory, "original"), "utf8")).toBe("owned bytes");
      } finally { await unrelated.close(); }
    } finally { await item.finish(); }
  });

  it("cannot reenter cleanup through an error code getter after descriptors have been consumed", async () => {
    let owner: StagedFile | undefined;
    let reentered: Promise<{ error: unknown }> | undefined;
    let attempted = false;
    const cause = Object.defineProperty(new Error("removal failed"), "code", {
      get() {
        if (!attempted) {
          attempted = true;
          reentered = rejection(owner!.cleanup());
        }
        return undefined;
      },
    });
    const item = await nativeFixture("remove", cause);
    owner = item.owner;
    try {
      const first = await rejection(owner.cleanup());
      const error = assertWrapped(first.error, cause);
      expect(reentered !== undefined).toBe(true);
      const duringSettlement = await reentered!;
      expect(duringSettlement.error instanceof FsSafeError).toBe(true);
      expect((duringSettlement.error as FsSafeError).code).toBe("helper-failed");
      expect((await rejection(owner.cleanup())).error === error).toBe(true);
      expect((await rejection(owner[Symbol.asyncDispose]())).error === error).toBe(true);
      expect(item.calls).toEqual({ remove: 1, fileClose: 1, parentClose: 1, rename: 0 });
      item.assertClosedOnce();
      expect(await fs.readFile(path.join(item.directory, owner.receipt.temporaryBasename), "utf8")).toBe("owned bytes");
    } finally { await item.finish(); }
  });

  it.each(hostileErrors.flatMap(error =>
    (["before", "after"] as const).flatMap(timing =>
      [false, true].map(overwrite => ({ ...error, timing, overwrite }))),
  ))("preserves names for $label $timing rename dispatch (overwrite=$overwrite)", async ({ create, timing, overwrite }) => {
    const cause = create();
    const item = await nativeFixture();
    const temporary = item.owner.receipt.temporaryBasename;
    const final = path.join(item.directory, "final");
    if (overwrite) await fs.writeFile(final, "previous target");
    const rename = overwrite ? "renameReplace" : "renameNoReplace";
    item.binding[rename] = (...args) => {
      item.calls.rename += 1;
      if (timing === "after") native![rename](...args);
      throw cause;
    };
    try {
      const first = await rejection(item.owner.publish("final", { overwrite }));
      const error = assertWrapped(first.error, cause);
      const publication = error.details?.publication;
      expect(error.details?.phase).toBe("publish");
      expect(publication).toEqual({ status: "indeterminate", basename: "final", overwrite });
      expect(Object.isFrozen(publication)).toBe(true);
      const expectedNames = timing === "after" ? ["final"] : overwrite ? [temporary, "final"].sort() : [temporary];
      const preserved = timing === "after" ? "final" : temporary;
      const stat = await fs.stat(path.join(item.directory, preserved), { bigint: true });
      expect({ dev: stat.dev, ino: stat.ino }).toEqual({
        dev: item.owner.receipt.identity.dev, ino: item.owner.receipt.identity.ino,
      });
      expect((await fs.readdir(item.directory)).sort()).toEqual(expectedNames);
      expect(await fs.readFile(path.join(item.directory, preserved), "utf8")).toBe("owned bytes");
      if (overwrite && timing === "before") expect(await fs.readFile(final, "utf8")).toBe("previous target");
      // A second publish while still open must not dispatch another rename.
      const retry = await rejection(item.owner.publish("retry", { overwrite }));
      expect(retry.error instanceof FsSafeError).toBe(true);
      expect((retry.error as FsSafeError).details?.publication === publication).toBe(true);
      const cleanup = await item.owner.cleanup();
      expect(cleanup).toEqual({ temporaryBasename: temporary, publication, status: "preserved", resources: "closed" });
      expect(await item.owner.cleanup() === cleanup).toBe(true);
      const disposal = await rejection(item.owner[Symbol.asyncDispose]());
      const disposalError = assertWrapped(disposal.error, undefined, "not-removable");
      expect(disposalError.details?.cleanup === cleanup).toBe(true);
      expect(item.calls).toEqual({ remove: 0, fileClose: 1, parentClose: 1, rename: 1 });
      item.assertClosedOnce();
      expect((await fs.readdir(item.directory)).sort()).toEqual(expectedNames);
      expect(await fs.readFile(path.join(item.directory, preserved), "utf8")).toBe("owned bytes");
    } finally { await item.finish(); }
  });

  it.each(["before", "after"] as const)("preserves uncertain publication when a code getter reenters cleanup %s rename dispatch", async timing => {
    const item = await nativeFixture();
    let cleanupAttempts = 0;
    let reentered: Promise<{ cleanup: StagedFileCleanupReceipt } | { error: unknown }> | undefined;
    const cause = Object.defineProperty(new Error("rename reply unavailable"), "code", {
      get() {
        if (cleanupAttempts === 0) {
          cleanupAttempts += 1;
          reentered = item.owner.cleanup().then(
            cleanup => ({ cleanup }),
            (error: unknown) => ({ error }),
          );
        }
        return undefined;
      },
    });
    item.binding.renameNoReplace = (...args) => {
      item.calls.rename += 1;
      if (timing === "after") native!.renameNoReplace(...args);
      throw cause;
    };
    try {
      const first = await rejection(item.owner.publish("final", { overwrite: false }));
      const error = assertWrapped(first.error, cause);
      expect(error.details?.phase).toBe("publish");
      const publication = error.details?.publication;
      expect(publication).toEqual({ status: "indeterminate", basename: "final", overwrite: false });
      expect(cleanupAttempts).toBe(1);
      const settled = await reentered!;
      expect("cleanup" in settled).toBe(true);
      if (!("cleanup" in settled)) throw new Error("reentrant cleanup unexpectedly rejected");
      const cleanup = settled.cleanup;
      expect(cleanup).toEqual({
        temporaryBasename: item.owner.receipt.temporaryBasename,
        publication, status: "preserved", resources: "closed",
      });
      expect(cleanup.publication === publication).toBe(true);
      expect(Object.isFrozen(cleanup)).toBe(true);
      expect(await item.owner.cleanup() === cleanup).toBe(true);
      const retry = await rejection(item.owner.publish("retry", { overwrite: false }));
      expect(retry.error instanceof FsSafeError).toBe(true);
      expect((retry.error as FsSafeError).details?.publication === publication).toBe(true);
      const disposal = await rejection(item.owner[Symbol.asyncDispose]());
      const disposalError = assertWrapped(disposal.error, undefined, "not-removable");
      expect(disposalError.details?.cleanup === cleanup).toBe(true);
      expect(item.calls).toEqual({ remove: 0, fileClose: 1, parentClose: 1, rename: 1 });
      item.assertClosedOnce();
      const name = timing === "after" ? "final" : item.owner.receipt.temporaryBasename;
      expect(await fs.readdir(item.directory)).toEqual([name]);
      const stat = await fs.stat(path.join(item.directory, name), { bigint: true });
      expect({ dev: stat.dev, ino: stat.ino }).toEqual({
        dev: item.owner.receipt.identity.dev, ino: item.owner.receipt.identity.ino,
      });
      expect(await fs.readFile(path.join(item.directory, name), "utf8")).toBe("owned bytes");
    } finally { await item.finish(); }
  });
});
