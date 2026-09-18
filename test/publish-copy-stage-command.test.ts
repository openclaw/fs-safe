import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { FsSafeError } from "../src/errors.js";
import { publishCopyStage } from "../src/publish-copy-stage.js";
import * as command from "../src/sibling-rename-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const owned: number[] = [];
beforeEach(() => vi.spyOn(process, "emitWarning").mockImplementation(() => undefined));
afterEach(() => {
  vi.restoreAllMocks();
  for (const fd of owned.splice(0)) {
    try { fsSync.closeSync(fd); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    }
  }
});

async function fixture() {
  const base = await tempRoot("fs-safe-copy-stage-command-");
  const directory = path.join(base, "parent");
  await fs.mkdir(directory, { mode: 0o700 });
  const temporaryPath = path.join(directory, "stage");
  const targetPath = path.join(directory, "final");
  const fd = fsSync.openSync(temporaryPath, "wx+", 0o600);
  owned.push(fd);
  fsSync.writeFileSync(fd, "complete private stage");
  const identity = fsSync.fstatSync(fd, { bigint: true });
  const parentGuard = await createAsyncDirectoryGuard(directory, { bigint: true });
  const onPublished = vi.fn();
  const onIndeterminate = vi.fn();
  return { base, directory, temporaryPath, targetPath, fd, identity, parentGuard, onPublished, onIndeterminate };
}

function blockHardlinks() {
  return vi.spyOn(fsSync, "linkSync").mockImplementation(() => {
    throw Object.assign(new Error("hardlinks unsupported"), { code: "ENOTSUP" });
  });
}
const posix = it.skipIf(process.platform === "win32");

describe("completed copy stage atomic command admission", () => {
  it("rechecks authority after hardlink capability failure without dispatching", async () => {
    const params = await fixture();
    const expired = Object.assign(new Error("writer authority expired"), { code: "EPERM" });
    const link = blockHardlinks();
    const rename = vi.spyOn(command, "renameSiblingNoReplaceSync");
    expect(() => publishCopyStage({ ...params, assertBeforeMutation() {
      if (link.mock.calls.length) throw expired;
    } })).toThrow(expired);
    expect(link).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expect(params.onPublished).not.toHaveBeenCalled();
    expect(params.onIndeterminate).not.toHaveBeenCalled();
    expect(fsSync.readFileSync(params.temporaryPath, "utf8")).toBe("complete private stage");
  });

  posix.each(["source", "parent", "symlink"] as const)("refences a %s changed by the renewed authority callback", async change => {
    const params = await fixture();
    const link = blockHardlinks();
    const rename = vi.spyOn(command, "renameSiblingNoReplaceSync");
    const retired = path.join(params.base, "retired");
    expect(() => publishCopyStage({ ...params, rejectFinalSymlink: true, assertBeforeMutation() {
      if (!link.mock.calls.length) return;
      if (change === "source") {
        fsSync.renameSync(params.temporaryPath, retired);
        fsSync.writeFileSync(params.temporaryPath, "replacement stage", { flag: "wx" });
      } else if (change === "parent") {
        fsSync.renameSync(params.directory, retired);
        fsSync.mkdirSync(params.directory);
        fsSync.writeFileSync(params.temporaryPath, "replacement parent");
      } else {
        fsSync.writeFileSync(retired, "symlink sentinel");
        fsSync.symlinkSync(retired, params.targetPath);
      }
    } })).toThrow(expect.objectContaining({ code: change === "symlink" ? "symlink" : "path-mismatch" }));
    expect(rename).not.toHaveBeenCalled();
    expect(params.onPublished).not.toHaveBeenCalled();
    expect(params.onIndeterminate).not.toHaveBeenCalled();
    if (change === "source") expect(fsSync.readFileSync(retired, "utf8")).toBe("complete private stage");
    else if (change === "parent") expect(fsSync.readFileSync(path.join(retired, "stage"), "utf8")).toBe("complete private stage");
    else expect(fsSync.readFileSync(params.targetPath, "utf8")).toBe("symlink sentinel");
  });

  it("refuses a command retry if the failed link attempt changed the source link count", async () => {
    const params = await fixture();
    const link = fsSync.linkSync;
    vi.spyOn(fsSync, "linkSync").mockImplementation((...args) => {
      link(...args);
      throw Object.assign(new Error("reply lost"), { code: "ENOTSUP" });
    });
    const rename = vi.spyOn(command, "renameSiblingNoReplaceSync");
    expect(() => publishCopyStage(params)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(rename).not.toHaveBeenCalled();
    expect(params.onPublished).not.toHaveBeenCalled();
    expect(fsSync.lstatSync(params.targetPath, { bigint: true })).toMatchObject({ ino: params.identity.ino, nlink: 2n });
  });

  it("leaves a pre-dispatch command failure unpublished", async () => {
    const params = await fixture();
    blockHardlinks();
    const unavailable = new FsSafeError("helper-unavailable", "runtime missing", { details: { commit: "not-attempted" } });
    vi.spyOn(command, "renameSiblingNoReplaceSync").mockImplementation(() => { throw unavailable; });
    expect(() => publishCopyStage(params)).toThrow(unavailable);
    expect(params.onPublished).not.toHaveBeenCalled();
    expect(params.onIndeterminate).not.toHaveBeenCalled();
    expect(fsSync.readFileSync(params.temporaryPath, "utf8")).toBe("complete private stage");
  });

  it("does not accept publication claims from a pre-dispatch authority rejection", async () => {
    const params = await fixture();
    const link = blockHardlinks();
    const rename = vi.spyOn(command, "renameSiblingNoReplaceSync");
    const expired = new FsSafeError("helper-failed", "authority rejected", { details: { commit: "committed" } });
    expect(() => publishCopyStage({ ...params, assertBeforeMutation() {
      if (link.mock.calls.length) throw expired;
    } })).toThrow(expired);
    expect(rename).not.toHaveBeenCalled();
    expect(params.onPublished).not.toHaveBeenCalled();
    expect(params.onIndeterminate).not.toHaveBeenCalled();
    expect(fsSync.existsSync(params.targetPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
    "does not add directory-read permission to command publication", async () => {
      const params = await fixture();
      blockHardlinks();
      await fs.chmod(params.directory, 0o300);
      try {
        await expect(fs.open(params.directory, "r")).rejects.toMatchObject({ code: "EACCES" });
        publishCopyStage(params);
        expect(params.onPublished).toHaveBeenCalledOnce();
        expect(fsSync.readFileSync(params.targetPath, "utf8")).toBe("complete private stage");
        expect(fsSync.lstatSync(params.targetPath, { bigint: true })).toMatchObject({
          dev: params.identity.dev, ino: params.identity.ino,
        });
      } finally {
        await fs.chmod(params.directory, 0o700);
      }
    }, 30_000,
  );
});

describe("completed copy stage atomic command settlement", () => {
  it("preserves an explicitly unknown outcome even with a collision-shaped code", async () => {
    const params = await fixture();
    blockHardlinks();
    const failure = Object.assign(new Error("unverified collision"), { code: "EEXIST", commit: "unknown" });
    vi.spyOn(command, "renameSiblingNoReplaceSync").mockImplementation(() => { throw failure; });
    expect(() => publishCopyStage(params)).toThrow(failure);
    expect(params.onIndeterminate).toHaveBeenCalledOnce();
    expect(params.onPublished).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles an unknown outcome without a publication receipt (renamed=%s)", async renamed => {
    const params = await fixture();
    blockHardlinks();
    const unknown = new FsSafeError("helper-failed", "reply lost", { details: { commit: "unknown" } });
    const rename = vi.spyOn(command, "renameSiblingNoReplaceSync").mockImplementation(() => {
      if (renamed) fsSync.renameSync(params.temporaryPath, params.targetPath);
      throw unknown;
    });
    expect(() => publishCopyStage(params)).toThrow(unknown);
    expect(rename).toHaveBeenCalledOnce();
    expect(params.onIndeterminate).toHaveBeenCalledOnce();
    expect(params.onPublished).not.toHaveBeenCalled();
    expect(fsSync.readFileSync(renamed ? params.targetPath : params.temporaryPath, "utf8")).toBe("complete private stage");
  });

  it.each([false, true])("notifies a confirmed commit before parent close (bridge error=%s)", async bridgeError => {
    const params = await fixture();
    blockHardlinks();
    const committed = new FsSafeError("helper-failed", "committed verification failed", { details: { commit: "committed" } });
    const observerFailure = new Error("observer rejected");
    const closeFailure = new Error("parent close rejected");
    let parentFd: number | undefined;
    vi.spyOn(command, "renameSiblingNoReplaceSync").mockImplementation(input => {
      parentFd = input.parent.fd;
      expect(input.source.fd).toBe(params.fd);
      expect(input.source.identity).toMatchObject({ dev: params.identity.dev, ino: params.identity.ino });
      fsSync.renameSync(params.temporaryPath, params.targetPath);
      if (bridgeError) throw committed;
    });
    params.onPublished.mockImplementation(identity => {
      expect(identity).toBe(params.identity);
      if (parentFd !== undefined) expect(fsSync.fstatSync(parentFd).isDirectory()).toBe(true);
      expect(fsSync.readFileSync(params.targetPath, "utf8")).toBe("complete private stage");
      throw observerFailure;
    });
    const close = fsSync.closeSync;
    vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
      close(fd);
      if (fd === parentFd) {
        expect(params.onPublished).toHaveBeenCalledOnce();
        throw closeFailure;
      }
    });
    let failure: unknown;
    try { publishCopyStage(params); } catch (error) { failure = error; }
    expect(params.onPublished).toHaveBeenCalledOnce();
    expect(params.onIndeterminate).not.toHaveBeenCalled();
    if (process.platform !== "win32") expect(failure).toMatchObject({ error: closeFailure,
      suppressed: bridgeError ? { error: observerFailure, suppressed: committed } : observerFailure });
    else if (bridgeError) expect(failure).toMatchObject({ error: observerFailure, suppressed: committed });
    else expect(failure).toBe(observerFailure);
    expect(fsSync.existsSync(params.temporaryPath)).toBe(false);
    expect(fsSync.lstatSync(params.targetPath, { bigint: true })).toMatchObject({ dev: params.identity.dev, ino: params.identity.ino });
  });
});
