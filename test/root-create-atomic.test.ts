import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const modes = nativeAvailable ? ["off", "require"] as const : ["off"] as const;
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

function afterFirstPartialWrite(inspect: (fd: number) => Promise<void> | void): void {
  let intercepted = false;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const write = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementation((async (buffer, offset, length, position) => {
      if (intercepted) return await write(buffer, offset, length, position);
      intercepted = true;
      const result = await write(buffer, offset, Math.min(length, 3), position);
      await inspect(handle.fd);
      return result;
    }) as typeof handle.write);
    return handle;
  });
  const write = fsSync.write.bind(fsSync);
  vi.spyOn(fsSync, "write").mockImplementation(((fd, buffer, offset, length, position, callback) => {
    if (intercepted) return write(fd, buffer, offset, length, position, callback);
    intercepted = true;
    return write(fd, buffer, offset, Math.min(length, 3), position, (error, bytesWritten) => {
      if (error) return callback(error, bytesWritten, buffer);
      void Promise.resolve().then(() => inspect(fd)).then(
        () => callback(null, bytesWritten, buffer),
        (failure: NodeJS.ErrnoException) => callback(failure, bytesWritten, buffer),
      );
    });
  }) as typeof fsSync.write);
}

function denyStageRemoval(directory: string, failure: Error): void {
  const isStage = (pathname: unknown) => path.dirname(String(pathname)) === directory &&
    path.basename(String(pathname)).startsWith(".fs-safe-");
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation(async (pathname) => {
    if (isStage(pathname)) throw failure;
    await unlink(pathname);
  });
  const unlinkSync = fsSync.unlinkSync.bind(fsSync);
  vi.spyOn(fsSync, "unlinkSync").mockImplementation((pathname) => {
    if (isStage(pathname)) throw failure;
    unlinkSync(pathname);
  });
}

describe.each(modes)("atomic buffered Root.create (native %s)", (mode) => {
  async function workspace() {
    configureFsSafeNative({ mode });
    return await root(await tempRoot("fs-safe-create-atomic-"), { durable: false });
  }

  it.each(["create", "createJson"] as const)(
    "%s keeps the destination absent during partial writes and publishes complete bytes",
    async (operation) => {
      const capability = await workspace();
      const target = path.join(capability.rootReal, "file");
      const value = { message: "é:🙂 complete" };
      const content = JSON.stringify(value);
      let observedPartial = false;
      afterFirstPartialWrite(async (fd) => {
        expect(fsSync.fstatSync(fd).size).toBe(3);
        await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
        observedPartial = true;
      });

      if (operation === "createJson") {
        await capability.createJson("file", value, { atomic: true, space: 0, trailingNewline: false, mode: 0o640 });
      } else {
        await capability.create("file", Buffer.from(content), { atomic: true, mode: 0o640 });
      }
      expect(observedPartial).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe(content);
      const stat = await fs.stat(target);
      expect(stat.nlink).toBe(1);
      if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o640);
      expect(await fs.readdir(capability.rootReal)).toEqual(["file"]);
    },
  );

  it("rejects a stage replaced by the final authority callback before publishing bytes", async () => {
    const capability = await workspace();
    let substituted = false;
    await expect(capability.create("file", "complete", {
      atomic: true,
      assertBeforeMutation() {
        if (substituted) return;
        const stage = fsSync.readdirSync(capability.rootReal).find(name => name.startsWith(".fs-safe-"));
        if (!stage) return;
        const stagedPath = path.join(capability.rootReal, stage);
        if (fsSync.statSync(stagedPath).size !== 8) return;
        fsSync.renameSync(stagedPath, path.join(capability.rootReal, "retained"));
        fsSync.writeFileSync(stagedPath, "substitute");
        substituted = true;
      },
    })).rejects.toBeTruthy();
    expect(substituted).toBe(true);
    await expect(fs.lstat(path.join(capability.rootReal, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(capability.rootReal, "retained"), "utf8")).toBe("complete");
  });

  it("removes an unpublished partial write and closes its descriptor when writing fails", async () => {
    const capability = await workspace();
    const failure = Object.assign(new Error("synthetic partial write failure"), { code: "EIO" });
    let writtenFd: number | undefined;
    afterFirstPartialWrite((fd) => { writtenFd = fd; throw failure; });

    await expect(capability.create("file", "incomplete", { atomic: true })).rejects.toMatchObject({ cause: failure });
    expect(writtenFd).toBeDefined();
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
    expect(() => fsSync.fstatSync(writtenFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("rechecks current authority after completed content writes before publication", async () => {
    const capability = await workspace();
    const failure = new Error("synthetic revoked publication authority");
    let authorized = true;
    afterFirstPartialWrite(() => { authorized = false; });

    await expect(capability.create("file", "all", {
      atomic: true,
      assertBeforeMutation: () => { if (!authorized) throw failure; },
    })).rejects.toBe(failure);
    expect(authorized).toBe(false);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it.each([
    { kind: "file", raced: false },
    { kind: "dangling-symlink", raced: false },
    { kind: "file", raced: true },
    { kind: "directory", raced: true },
    { kind: "hardlink", raced: true },
  ] as const)("preserves a $kind winner (raced=$raced)", async ({ kind, raced }) => {
    const capability = await workspace();
    const target = path.join(capability.rootReal, "file");
    const referent = path.join(capability.rootReal, "referent");
    if (kind === "hardlink") await fs.writeFile(referent, "winner");
    let winner: fsSync.BigIntStats | undefined;
    const createWinner = async () => {
      if (kind === "directory") await fs.mkdir(target);
      else if (kind === "hardlink") await fs.link(referent, target);
      else if (kind === "dangling-symlink") await fs.symlink(referent, target, "file");
      else await fs.writeFile(target, "winner", { flag: "wx" });
      winner = await fs.lstat(target, { bigint: true });
    };
    if (raced) afterFirstPartialWrite(createWinner);
    else await createWinner();

    await expect(capability.create("file", "replacement", { atomic: true })).rejects.toBeTruthy();
    expect(winner).toBeDefined();
    expect(await fs.lstat(target, { bigint: true })).toMatchObject({
      dev: winner!.dev, ino: winner!.ino, nlink: winner!.nlink, mode: winner!.mode,
    });
    if (kind === "dangling-symlink") {
      expect(await fs.readlink(target)).toBe(referent);
      await expect(fs.lstat(referent)).rejects.toMatchObject({ code: "ENOENT" });
    } else if (kind === "directory") {
      expect(await fs.readdir(target)).toEqual([]);
    } else {
      expect(await fs.readFile(target, "utf8")).toBe("winner");
      if (kind === "hardlink") expect(await fs.readFile(referent, "utf8")).toBe("winner");
    }
  });

  it("settles concurrent creators with one complete winner and one link", async () => {
    const capability = await workspace();
    const competitor = await root(capability.rootReal, { durable: false });
    const first = Buffer.alloc(64 * 1024, 0x41);
    const second = Buffer.alloc(64 * 1024, 0x42);
    const results = await Promise.allSettled([
      capability.create("file", first, { atomic: true }),
      competitor.create("file", second, { atomic: true }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({
      reason: { code: "already-exists" },
    });
    expect(await fs.readFile(path.join(capability.rootReal, "file"))).toEqual(
      results[0]!.status === "fulfilled" ? first : second,
    );
    expect((await fs.stat(path.join(capability.rootReal, "file"))).nlink).toBe(1);
    expect(await fs.readdir(capability.rootReal)).toEqual(["file"]);
  });
});

describe("atomic create fallback settlement", () => {
  async function workspace() {
    configureFsSafeNative({ mode: "off" });
    return await root(await tempRoot("fs-safe-create-atomic-settlement-"), { durable: false });
  }



  it.each([false, true])("uses no weaker publication when hardlinks are unavailable (atomic=%s)", async (atomic) => {
    const capability = await workspace();
    const failure = Object.assign(new Error("filesystem does not support hardlinks"), { code: "ENOTSUP" });
    vi.spyOn(fsSync, "linkSync").mockImplementation(() => { throw failure; });
    const pending = capability.create("file", "complete", { atomic });
    if (atomic) {
      await expect(pending).rejects.toMatchObject({
        cause: failure,
        details: { publication: { status: "indeterminate" }, cleanup: { status: "preserved" } },
      });
      await expect(fs.lstat(path.join(capability.rootReal, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(pending).resolves.toBeUndefined();
      expect(await fs.readFile(path.join(capability.rootReal, "file"), "utf8")).toBe("complete");
    }
  });

  it("preserves complete bytes and reports an indeterminate link whose reply is lost", async () => {
    const capability = await workspace();
    const failure = Object.assign(new Error("link reply lost"), { code: "EIO" });
    const link = fsSync.linkSync.bind(fsSync);
    vi.spyOn(fsSync, "linkSync").mockImplementation((source, target) => {
      link(source, target);
      throw failure;
    });
    await expect(capability.create("file", "complete", { atomic: true })).rejects.toMatchObject({
      cause: failure,
      details: { publication: { status: "indeterminate" }, cleanup: { status: "preserved", resources: "closed" } },
    });
    expect(await fs.readFile(path.join(capability.rootReal, "file"), "utf8")).toBe("complete");
    expect((await fs.stat(path.join(capability.rootReal, "file"))).nlink).toBe(2);
    expect(await fs.readdir(capability.rootReal)).toHaveLength(2);
  });

  it("reports published bytes and a retained staging link when removal fails", async () => {
    const capability = await workspace();
    const failure = Object.assign(new Error("staging unlink denied"), { code: "EACCES" });
    denyStageRemoval(capability.rootReal, failure);

    await expect(capability.create("file", "complete", { atomic: true })).rejects.toMatchObject({
      details: {
        publication: { status: "published", basename: "file" },
        cleanup: { status: "failed", resources: "closed" },
      },
    });
    const target = path.join(capability.rootReal, "file");
    expect(await fs.readFile(target, "utf8")).toBe("complete");
    expect((await fs.stat(target)).nlink).toBe(2);
    const names = await fs.readdir(capability.rootReal);
    expect(names).toHaveLength(2);
    const stage = names.find(name => name !== "file")!;
    expect(await fs.readFile(path.join(capability.rootReal, stage), "utf8")).toBe("complete");
  });

  it("retains the write failure and the cleanup failure with an unpublished receipt", async () => {
    const capability = await workspace();
    const writeFailure = new Error("content write failed");
    const cleanupFailure = new Error("staging removal failed");
    afterFirstPartialWrite(() => { throw writeFailure; });
    denyStageRemoval(capability.rootReal, cleanupFailure);

    const error = await capability.create("file", "incomplete", { atomic: true }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      details: {
        publication: { status: "not-published" },
        cleanup: { status: "failed", resources: "closed" },
      },
      cause: expect.any(AggregateError),
    });
    expect(((error as Error).cause as AggregateError).errors).toEqual([writeFailure, cleanupFailure]);
    await expect(fs.lstat(path.join(capability.rootReal, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    const names = await fs.readdir(capability.rootReal);
    expect(names).toHaveLength(1);
    expect(await fs.readFile(path.join(capability.rootReal, names[0]!), "utf8")).toBe("inc");
  });

  it("reports a close failure after publication without deleting the complete target", async () => {
    const capability = await workspace();
    const failure = new Error("close reported failure after closing");
    const open = fs.open.bind(fs);
    let stagedFd: number | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.dirname(String(args[0])) !== capability.rootReal ||
        !path.basename(String(args[0])).startsWith(".fs-safe-")) return handle;
      stagedFd = handle.fd;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); throw failure; });
      return handle;
    });

    await expect(capability.create("file", "complete", { atomic: true })).rejects.toMatchObject({
      cause: failure,
      details: {
        publication: { status: "published", basename: "file" },
        cleanup: { status: "not-needed", resources: "close-failed" },
      },
    });
    expect(stagedFd).toBeDefined();
    expect(() => fsSync.fstatSync(stagedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(await fs.readFile(path.join(capability.rootReal, "file"), "utf8")).toBe("complete");
    expect(await fs.readdir(capability.rootReal)).toEqual(["file"]);
  });
});
