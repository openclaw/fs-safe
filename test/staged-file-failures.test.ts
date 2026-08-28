import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageFileInDirectory } from "../src/advanced.js";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { useTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  if (process.platform !== "win32") {
    native = __loadBundledNativeForTest();
  }
} catch {
  // Built binding is mandatory in the native CI lanes, absent in fallback CI.
}
const { tempRoot } = useTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

describe.runIf(native)("staged ownership failure boundaries", () => {
  it.each(["fstat", "chmod", "write", "sync"])("cleans a moved parent after %s fails during setup", async (operation) => {
    const directory = await tempRoot("fs-safe-stage-setup-");
    const moved = `${directory}-moved`;
    const failure = Object.assign(new Error(`injected ${operation}`), { code: "EIO" });
    const method = {
      fstat: "fstatSync", chmod: "fchmodSync", write: "writeSync", sync: "fsyncSync",
    }[operation] as "fstatSync";
    const original = fsSync[method];
    let createdFd: number | undefined;
    __setNativeLoaderForTest(() => ({
      ...native!,
      createStagedFile(...args) {
        createdFd = native!.createStagedFile!(...args);
        return createdFd;
      },
    }));
    const spy = vi.spyOn(fsSync, method).mockImplementation(((fd: number, ...args: never[]) => {
      if (fd === createdFd) {
        spy.mockRestore();
        fsSync.renameSync(directory, moved);
        fsSync.mkdirSync(directory);
        throw failure;
      }
      return Reflect.apply(original, fsSync, [fd, ...args]);
    }) as never);
    try {
      await expect(stageFileInDirectory({ directory, content: "partial" })).rejects.toBe(failure);
      expect(await fs.readdir(moved)).toEqual([]);
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await fs.rm(moved, { recursive: true, force: true });
    }
  });

  it("preserves an exclusive creation collision instead of claiming ownership", async () => {
    const directory = await tempRoot("fs-safe-stage-exclusive-");
    __setNativeLoaderForTest(() => ({
      ...native!,
      createStagedFile(fd, name) {
        fsSync.writeFileSync(path.join(directory, name), "collision");
        return native!.createStagedFile!(fd, name);
      },
    }));
    await expect(stageFileInDirectory({ directory, content: "owned" })).rejects.toBeTruthy();
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(1);
    expect(await fs.readFile(path.join(directory, names[0]!), "utf8")).toBe("collision");
  });

  it.each([
    "move-before-rename", "move-after-rename", "chmod", "file-sync", "directory-sync",
  ])("records committed publication on %s failure", async (fault) => {
    const directory = await tempRoot("fs-safe-stage-committed-");
    const moved = `${directory}-moved`;
    const failure = Object.assign(new Error(`injected ${fault}`), { code: "EIO" });
    __setNativeLoaderForTest(() => ({
      ...native!,
      renameReplace(...args) {
        if (fault === "move-before-rename") {
          fsSync.renameSync(directory, moved);
          fsSync.mkdirSync(directory);
          fsSync.writeFileSync(path.join(directory, "final"), "sentinel");
        }
        native!.renameReplace(...args);
        if (fault === "move-after-rename") {
          fsSync.renameSync(directory, moved);
          fsSync.mkdirSync(directory);
          fsSync.writeFileSync(path.join(directory, "final"), "sentinel");
        }
      },
    }));
    const staged = await stageFileInDirectory({ directory, content: "committed", mode: 0o666 });
    if (fault === "chmod") {
      vi.spyOn(fsSync, "fchmodSync").mockImplementation(() => {
        throw failure;
      });
    } else if (fault === "file-sync" || fault === "directory-sync") {
      const sync = fsSync.fsyncSync;
      vi.spyOn(fsSync, "fsyncSync").mockImplementation((fd) => {
        const matchesFault = fault === "file-sync"
          ? fsSync.fstatSync(fd).isFile()
          : fsSync.fstatSync(fd).isDirectory();
        if (matchesFault) {
          throw failure;
        }
        sync(fd);
      });
    }
    const parentMoved = fault.startsWith("move-");
    const final = path.join(parentMoved ? moved : directory, "final");
    try {
      await expect(staged.publish("final", { overwrite: true })).rejects.toMatchObject({
        details: { publication: { status: "published", basename: "final" } },
        ...(parentMoved ? {} : { cause: failure }),
      });
      expect(await staged.cleanup()).toMatchObject({
        status: "not-needed", publication: { status: "published" },
      });
      expect(await fs.readFile(final, "utf8")).toBe("committed");
      expect((await fs.lstat(final)).mode & 0o777).toBe(parentMoved || fault === "chmod" ? 0o600 : 0o666);
      expect(staged.receipt.identity.mode).toBe(0o600);
      if (parentMoved) {
        expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("sentinel");
      }
    } finally {
      await staged[Symbol.asyncDispose]();
      await fs.rm(moved, { recursive: true, force: true });
    }
  });

  it("does not broaden the created inode when the published entry fails its identity fence", async () => {
    const directory = await tempRoot("fs-safe-stage-published-substitute-");
    const final = path.join(directory, "final");
    const original = path.join(directory, "original");
    __setNativeLoaderForTest(() => ({
      ...native!,
      renameReplace(...args) {
        native!.renameReplace(...args);
        fsSync.renameSync(final, original);
        fsSync.writeFileSync(final, "substitute", { mode: 0o600 });
      },
    }));
    await using staged = await stageFileInDirectory({ directory, content: "private", mode: 0o666 });
    await expect(staged.publish("final", { overwrite: true })).rejects.toMatchObject({
      code: "path-mismatch", details: { publication: { status: "published" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "not-needed" });
    expect((await fs.lstat(original)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(final)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(original, "utf8")).toBe("private");
    expect(await fs.readFile(final, "utf8")).toBe("substitute");
  });

  it("reports cleanup failure through both cleanup and disposal and closes the lifecycle", async () => {
    const directory = await tempRoot("fs-safe-stage-unlink-failure-");
    const failure = Object.assign(new Error("unlink denied"), { code: "EACCES" });
    __setNativeLoaderForTest(() => ({
      ...native!,
      removeStagedFile() {
        throw failure;
      },
    }));
    const staged = await stageFileInDirectory({ directory, content: "still here" });
    await expect(staged.cleanup()).rejects.toMatchObject({
      cause: failure, details: { cleanup: { status: "failed", resources: "closed" } },
    });
    await expect(staged[Symbol.asyncDispose]()).rejects.toMatchObject({
      details: { cleanup: { status: "failed" } },
    });
    await expect(staged.assertCurrent()).rejects.toMatchObject({ code: "helper-failed" });
    expect(await fs.readFile(path.join(directory, staged.receipt.temporaryBasename), "utf8")).toBe("still here");
  });

  it("keeps setup and cleanup errors together", async () => {
    const directory = await tempRoot("fs-safe-stage-double-failure-");
    const writeFailure = new Error("write failed");
    const unlinkFailure = new Error("unlink failed");
    __setNativeLoaderForTest(() => ({
      ...native!,
      removeStagedFile() {
        throw unlinkFailure;
      },
    }));
    vi.spyOn(fsSync, "writeSync").mockImplementation(() => {
      throw writeFailure;
    });
    const error = await stageFileInDirectory({ directory, content: "x" }).catch((value: unknown) => value);
    expect(error).toMatchObject({
      details: { cleanup: { status: "failed" } }, cause: expect.any(AggregateError),
    });
    const causes = (error as Error).cause as AggregateError;
    expect(causes.errors[0]).toBe(writeFailure);
    expect(causes.errors[1]).toMatchObject({ cause: unlinkFailure });
  });

  it.each(["unlink", "close"])("retains publication evidence and a coordinator %s failure", async (fault) => {
    const directory = await tempRoot("fs-safe-writer-double-failure-");
    const writeFailure = Object.assign(new Error("publication failed"), { code: "EACCES" });
    const cleanupFailure = new Error(`${fault} failed`);
    const close = fsSync.closeSync;
    __setNativeLoaderForTest(() => ({
      ...native!,
      renameReplace(...args) {
        if (fault === "close") {
          native!.renameReplace(...args);
          vi.spyOn(fsSync, "closeSync").mockImplementationOnce((fd) => {
            close(fd);
            throw cleanupFailure;
          });
          vi.spyOn(fsSync, "fchmodSync").mockImplementationOnce(() => {
            throw writeFailure;
          });
        } else {
          throw writeFailure;
        }
      },
      removeStagedFile() {
        throw cleanupFailure;
      },
    }));
    const publication = { status: fault === "close" ? "published" : "not-published" };
    await expect(runPinnedWriteHelper({
      rootPath: directory, relativeParentPath: "", basename: "final", mkdir: false,
      mode: 0o666, overwrite: true, input: { kind: "buffer", data: "retained" },
    })).rejects.toMatchObject({
      name: "SuppressedError",
      suppressed: { cause: writeFailure, details: { phase: "publish", publication } },
      error: {
        cause: cleanupFailure,
        details: { phase: "cleanup", publication, cleanup: {
          status: fault === "close" ? "not-needed" : "failed",
          resources: fault === "close" ? "close-failed" : "closed",
        } },
      },
    });
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0] === "final").toBe(fault === "close");
    const retained = path.join(directory, names[0]!);
    expect(await fs.readFile(retained, "utf8")).toBe("retained");
    expect((await fs.lstat(retained)).mode & 0o777).toBe(0o600);
  });

  it.each(["io-error", "empty-error"])("preserves an indeterminate %s without treating it as an unpublished temp", async (kind) => {
    const directory = await tempRoot("fs-safe-stage-indeterminate-");
    __setNativeLoaderForTest(() => ({
      ...native!,
      renameNoReplace(...args) {
        native!.renameNoReplace(...args);
        throw kind === "empty-error" ? undefined : Object.assign(new Error("reply lost after rename"), { code: "EIO" });
      },
    }));
    const staged = await stageFileInDirectory({ directory, content: "published" });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      details: { publication: { status: "indeterminate", basename: "final" } },
    });
    expect(await staged.cleanup()).toMatchObject({
      status: "preserved", publication: { status: "indeterminate" },
    });
    await expect(staged[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "not-removable" });
    expect(await fs.readdir(directory)).toEqual(["final"]);
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("published");
  });

  it("reports close failure after successful removal and never reuses the closed descriptor", async () => {
    const directory = await tempRoot("fs-safe-stage-close-");
    const staged = await stageFileInDirectory({ directory, content: "remove me" });
    const close = fsSync.closeSync;
    const closeError = Object.assign(new Error("close reported failure"), { code: "EIO" });
    const spy = vi.spyOn(fsSync, "closeSync").mockImplementationOnce((fd) => {
      close(fd);
      throw closeError;
    });
    await expect(staged.cleanup()).rejects.toMatchObject({
      cause: closeError, details: { cleanup: { status: "removed", resources: "close-failed" } },
    });
    spy.mockRestore();
    expect(await fs.readdir(directory)).toEqual([]);
    const unrelated = await fs.open(path.join(directory, "unrelated"), "w+");
    try {
      await expect(staged.cleanup()).rejects.toMatchObject({ cause: closeError });
      await expect(staged[Symbol.asyncDispose]()).rejects.toMatchObject({ cause: closeError });
      await unrelated.writeFile("still open");
      expect(await fs.readFile(path.join(directory, "unrelated"), "utf8")).toBe("still open");
    } finally {
      await unrelated.close();
    }
  });

  it("keeps a body error visible when async disposal preserves a substitute", async () => {
    const directory = await tempRoot("fs-safe-stage-dispose-");
    const bodyError = new Error("application check failed");
    const run = async () => {
      await using staged = await stageFileInDirectory({ directory, content: "owned" });
      const temporary = path.join(directory, staged.receipt.temporaryBasename);
      await fs.rename(temporary, path.join(directory, "owned-renamed"));
      await fs.writeFile(temporary, "substitute");
      throw bodyError;
    };
    await expect(run()).rejects.toMatchObject({
      name: "SuppressedError", suppressed: bodyError,
      error: { details: { cleanup: { status: "preserved" } } },
    });
    expect(await fs.readFile(path.join(directory, "owned-renamed"), "utf8")).toBe("owned");
  });

  it("does not block when the staged name becomes a FIFO", async () => {
    const directory = await tempRoot("fs-safe-stage-fifo-");
    const staged = await stageFileInDirectory({ directory, content: "x" });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    await fs.rename(temporary, path.join(directory, "original"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [temporary]);
    await expect(staged.assertCurrent()).rejects.toMatchObject({ code: "path-mismatch" });
    expect(await staged.cleanup()).toMatchObject({ status: "preserved" });
    expect((await fs.lstat(temporary)).isFIFO()).toBe(true);
  });
});
