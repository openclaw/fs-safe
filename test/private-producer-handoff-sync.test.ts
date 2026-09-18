import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ownFileDescriptorSync, type OwnedFileDescriptorSync } from "../src/create-owned-file.js";
import { assertSyncDirectoryGuard, createSyncDirectoryGuard } from "../src/directory-guard.js";
import { FsSafeError } from "../src/errors.js";
import { handoffCreatedFileSync } from "../src/private-producer-handoff-sync.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const owners = new Set<OwnedFileDescriptorSync>();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  for (const owner of owners) owner.close();
  owners.clear();
});

type HandoffOptions = Parameters<typeof handoffCreatedFileSync>[0];

async function fixture(closeFd = fs.closeSync) {
  const directory = await tempRoot("fs-safe-created-handoff-");
  const stage = path.join(directory, "private");
  fs.mkdirSync(stage);
  const sourcePath = path.join(stage, "source");
  const targetPath = path.join(directory, "target");
  const fd = fs.openSync(sourcePath, "wx+", 0o600);
  const source = ownFileDescriptorSync(fd, closeFd);
  owners.add(source);
  fs.writeSync(fd, "producer");
  const identity = fs.fstatSync(fd, { bigint: true });
  const sourceParent = createSyncDirectoryGuard(stage);
  const targetParent = createSyncDirectoryGuard(directory);
  function run(options: Partial<HandoffOptions> = {}): OwnedFileDescriptorSync {
    const result = handoffCreatedFileSync({
      source, sourcePath, targetPath, identity,
      assertSourceParent: () => assertSyncDirectoryGuard(sourceParent),
      assertTargetParent: () => assertSyncDirectoryGuard(targetParent),
      ...options,
    });
    owners.add(result);
    return result;
  }
  return { directory, stage, sourcePath, targetPath, fd, source, identity, run };
}

function failure(run: () => unknown): FsSafeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FsSafeError);
    return error as FsSafeError;
  }
  throw new Error("expected publication failure");
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

it("publishes the created inode and leaves one usable read/write descriptor", async () => {
  const f = await fixture();
  const result = f.run();
  expect(fs.fstatSync(result.fd, { bigint: true })).toMatchObject({
    dev: f.identity.dev, ino: f.identity.ino, nlink: 1n,
  });
  expect(fs.lstatSync(f.targetPath, { bigint: true })).toMatchObject({
    dev: f.identity.dev, ino: f.identity.ino, nlink: 1n,
  });
  fs.rmdirSync(f.stage);
  fs.writeSync(result.fd, Buffer.from("!"), 0, 1, 8);
  expect(fs.readFileSync(f.targetPath, "utf8")).toBe("producer!");
  result.close();
  expect(() => fs.fstatSync(result.fd)).toThrow();
});

it("overlaps verified Windows pins and closes the source before removing its name", async () => {
  let targetFd = -1;
  let targetVerified = false;
  let sourceClosed = false;
  const close = fs.closeSync.bind(fs);
  const f = await fixture(fd => {
    try {
      expect(targetVerified).toBe(true);
      expect(fs.fstatSync(targetFd, { bigint: true }).ino).toBe(f.identity.ino);
    } finally {
      close(fd);
      sourceClosed = true;
    }
  });
  Object.defineProperty(process, "platform", { value: "win32" });
  const open = fs.openSync.bind(fs);
  vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    expect(args[0]).toBe(f.targetPath);
    expect(args[1]).toBe(fs.constants.O_RDWR);
    expect(fs.fstatSync(f.fd, { bigint: true }).nlink).toBe(2n);
    return targetFd = open(...args);
  });
  const unlink = fs.unlinkSync.bind(fs);
  vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
    expect(file).toBe(f.sourcePath);
    expect(sourceClosed).toBe(true);
    expect(fs.fstatSync(targetFd, { bigint: true }).nlink).toBe(2n);
    unlink(file);
  });

  const result = f.run({
    verifyDescriptor: (fd, file, links) => {
      if (file === f.targetPath && links === 2 && !targetVerified) {
        expect(fd).toBe(targetFd);
        expect(sourceClosed).toBe(false);
        expect(fs.fstatSync(f.fd, { bigint: true }).ino).toBe(f.identity.ino);
        targetVerified = true;
      }
    },
  });
  expect(result.fd).toBe(targetFd);
  expect(sourceClosed).toBe(true);
  fs.rmdirSync(f.stage);
  expect(fs.fstatSync(result.fd, { bigint: true }).nlink).toBe(1n);
});

it.for(["file", "directory", "symlink"] as const)("preserves an existing %s collision", async (kind, context) => {
  const f = await fixture();
  if (kind === "file") fs.writeFileSync(f.targetPath, "winner");
  else if (kind === "directory") fs.mkdirSync(f.targetPath);
  else {
    try {
      fs.symlinkSync(path.join(f.directory, "missing"), f.targetPath, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Windows symlink creation requires Developer Mode or privilege");
      }
      throw error;
    }
  }
  const winner = fs.lstatSync(f.targetPath, { bigint: true });
  const onPublished = vi.fn();

  expect(failure(() => f.run({ onPublished }))).toMatchObject({
    code: "already-exists",
    details: { publication: { status: "not-published" }, cleanup: "preserved", resources: "closed" },
  });
  expect(onPublished).not.toHaveBeenCalled();
  expect(fs.lstatSync(f.targetPath, { bigint: true })).toMatchObject({ dev: winner.dev, ino: winner.ino });
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
  expect(() => fs.fstatSync(f.fd)).toThrow();
});

it("reports settlement failure when a raced collision is followed by a failed close", async () => {
  const closeError = new Error("close failed after release");
  const close = fs.closeSync.bind(fs);
  const closeOwned = vi.fn((fd: number) => { close(fd); throw closeError; });
  const f = await fixture(closeOwned);
  const onPublished = vi.fn();

  const error = failure(() => f.run({
    assertBeforeMutation: () => fs.writeFileSync(f.targetPath, "winner", { flag: "wx" }),
    onPublished,
  }));
  expect(error).toMatchObject({
    code: "helper-failed",
    details: { publication: { status: "not-published" }, cleanup: "preserved", resources: "close-failed" },
  });
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect((error.cause as AggregateError).errors).toEqual([
    expect.objectContaining({ code: "already-exists", cause: expect.objectContaining({ code: "EEXIST" }) }),
    closeError,
  ]);
  expect(onPublished).not.toHaveBeenCalled();
  expect(closeOwned).toHaveBeenCalledOnce();
  expect(() => fs.fstatSync(f.fd)).toThrow();
  expect(fs.readFileSync(f.targetPath, "utf8")).toBe("winner");
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
});

it.each([new Error("observer rejected"), undefined])("settles publication when its observer throws %s", async rejected => {
  const f = await fixture();
  const onPublished = vi.fn(() => {
    expect(fs.lstatSync(f.targetPath, { bigint: true })).toMatchObject({ ino: f.identity.ino, nlink: 2n });
    throw rejected;
  });
  const error = failure(() => f.run({ onPublished }));
  expect(error.cause).toBe(rejected);
  expect(error.details).toMatchObject({ publication: { status: "published" }, cleanup: "removed", resources: "closed" });
  expect(onPublished).toHaveBeenCalledOnce();
  expect(fs.readFileSync(f.targetPath, "utf8")).toBe("producer");
  expect(fs.readdirSync(f.stage)).toEqual([]);
  expect(() => fs.fstatSync(f.fd)).toThrow();
});

it.each(["source", "target"] as const)("preserves a %s replacement observed after publication", async replaced => {
  const f = await fixture();
  const replacedPath = replaced === "source" ? f.sourcePath : f.targetPath;
  const saved = path.join(f.directory, "saved");
  const error = failure(() => f.run({
    onPublished: () => {
      fs.renameSync(replacedPath, saved);
      fs.writeFileSync(replacedPath, "competitor");
    },
  }));
  expect(error).toMatchObject({
    code: "path-mismatch",
    details: { publication: { status: "published" }, cleanup: "preserved", resources: "closed" },
  });
  expect(fs.readFileSync(replacedPath, "utf8")).toBe("competitor");
  expect(fs.readFileSync(saved, "utf8")).toBe("producer");
  expect(fs.readFileSync(replaced === "source" ? f.targetPath : f.sourcePath, "utf8")).toBe("producer");
});

it("retains observer, stage cleanup, and descriptor close failures after publication", async () => {
  const cleanupError = errno("EBUSY");
  const closeError = new Error("close failed after release");
  const close = fs.closeSync.bind(fs);
  const f = await fixture(fd => { close(fd); throw closeError; });
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw cleanupError; });

  const error = failure(() => f.run({ onPublished: () => { throw undefined; } }));
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect((error.cause as AggregateError).errors).toEqual([undefined, cleanupError, closeError]);
  expect(error.details).toMatchObject({ publication: { status: "published" }, cleanup: "failed", resources: "close-failed" });
  expect(fs.readFileSync(f.targetPath, "utf8")).toBe("producer");
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
});

it("closes both Windows descriptors when published-name verification rejects", async () => {
  const f = await fixture();
  const rejected = new FsSafeError("insecure-permissions", "published descriptor security changed");
  Object.defineProperty(process, "platform", { value: "win32" });
  let siblingFd = -1;
  const open = fs.openSync.bind(fs);
  vi.spyOn(fs, "openSync").mockImplementation((...args) => siblingFd = open(...args));

  const error = failure(() => f.run({
    verifyDescriptor: (_fd, file) => { if (file === f.targetPath) throw rejected; },
  }));
  expect(error).toMatchObject({
    cause: rejected,
    details: { publication: { status: "published" }, cleanup: "preserved", resources: "closed" },
  });
  expect(siblingFd).toBeGreaterThanOrEqual(0);
  expect(() => fs.fstatSync(f.fd)).toThrow();
  expect(() => fs.fstatSync(siblingFd)).toThrow();
  expect(fs.readFileSync(f.targetPath, "utf8")).toBe("producer");
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
});

it.each([1, 2])("rechecks mutation authority before mutation %s", async rejectedMutation => {
  const f = await fixture();
  const denied = new FsSafeError("denied-path", "authority changed");
  let mutations = 0;
  const error = failure(() => f.run({
    assertBeforeMutation: () => { if (++mutations === rejectedMutation) throw denied; },
  }));
  expect(error.cause).toBe(denied);
  expect(error.details).toMatchObject({
    publication: { status: rejectedMutation === 1 ? "not-published" : "published" },
    cleanup: "preserved", resources: "closed",
  });
  expect(fs.existsSync(f.targetPath)).toBe(rejectedMutation === 2);
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
  expect(() => fs.fstatSync(f.fd)).toThrow();
});

it.each([1, 2])("rejects and consumes a thenable returned at authority check %s", async rejectedMutation => {
  const f = await fixture();
  const rejected = new Error("asynchronous authority rejected");
  let mutations = 0;
  const onPublished = vi.fn();
  const error = failure(() => f.run({
    assertBeforeMutation: () => {
      if (++mutations === rejectedMutation) return Promise.reject(rejected);
    },
    onPublished,
  }));
  expect(error).toMatchObject({
    cause: new TypeError("assertBeforeMutation must be synchronous"),
    details: {
      publication: { status: rejectedMutation === 1 ? "not-published" : "published" },
      cleanup: "preserved", resources: "closed",
    },
  });
  expect(onPublished).toHaveBeenCalledTimes(rejectedMutation - 1);
  expect(fs.existsSync(f.targetPath)).toBe(rejectedMutation === 2);
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
  expect(() => fs.fstatSync(f.fd)).toThrow();
  // Let Node report an unhandled rejection if the synchronous guard lost it.
  await new Promise<void>(resolve => setImmediate(resolve));
});

it.each([1, 2])("preserves a source replacement introduced by authority check %s", async replacedMutation => {
  const f = await fixture();
  const saved = path.join(f.directory, "saved");
  let mutations = 0;
  const error = failure(() => f.run({
    assertBeforeMutation: () => {
      if (++mutations !== replacedMutation) return;
      fs.renameSync(f.sourcePath, saved);
      fs.writeFileSync(f.sourcePath, "competitor");
    },
  }));
  expect(error).toMatchObject({
    code: "path-mismatch",
    details: {
      publication: { status: replacedMutation === 1 ? "not-published" : "published" },
      cleanup: "preserved", resources: "closed",
    },
  });
  expect(fs.existsSync(f.targetPath)).toBe(replacedMutation === 2);
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("competitor");
  expect(fs.readFileSync(saved, "utf8")).toBe("producer");
});

it("checks authority after potentially blocking descriptor verification", async () => {
  const f = await fixture();
  const denied = new FsSafeError("denied-path", "authority expired");
  let authorized = true;
  expect(failure(() => f.run({
    verifyDescriptor: () => { authorized = false; },
    assertBeforeMutation: () => { if (!authorized) throw denied; },
  }))).toMatchObject({ cause: denied, details: { publication: { status: "not-published" } } });
  expect(fs.existsSync(f.targetPath)).toBe(false);
});

it.each(["EXDEV", "ENOTSUP", "EPERM"])("reports unavailable hardlink publication for %s", async code => {
  const f = await fixture();
  vi.spyOn(fs, "linkSync").mockImplementation(() => { throw errno(code); });
  expect(failure(() => f.run())).toMatchObject({
    code: "helper-unavailable",
    details: { publication: { status: "not-published" }, cleanup: "preserved", resources: "closed" },
  });
  expect(fs.existsSync(f.targetPath)).toBe(false);
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
});

it("preserves both names and reports indeterminate after an ambiguous dispatched link failure", async () => {
  const f = await fixture();
  const dispatchError = errno("EIO");
  const link = fs.linkSync.bind(fs);
  vi.spyOn(fs, "linkSync").mockImplementation((...args) => { link(...args); throw dispatchError; });
  const onPublished = vi.fn();

  const error = failure(() => f.run({ onPublished }));
  expect(error.cause).toBe(dispatchError);
  expect(error.details).toMatchObject({
    publication: { status: "indeterminate" }, cleanup: "preserved", resources: "closed",
    path: f.targetPath, dev: f.identity.dev, ino: f.identity.ino,
  });
  expect(onPublished).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.targetPath, "utf8")).toBe("producer");
  expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
});

it("does not close a recycled source descriptor after the Windows handoff close throws", async () => {
  const closeError = new Error("source close failed after release");
  const siblingCloseError = new Error("sibling close failed after release");
  const close = fs.closeSync.bind(fs);
  let recycled = -1;
  let sourceCloses = 0;
  const f = await fixture(fd => {
    sourceCloses++;
    close(fd);
    recycled = fs.openSync(path.join(f.directory, "unrelated"), "wx+");
    throw closeError;
  });
  Object.defineProperty(process, "platform", { value: "win32" });
  const siblingClose = vi.spyOn(fs, "closeSync").mockImplementation(fd => {
    close(fd);
    throw siblingCloseError;
  });
  try {
    const error = failure(() => f.run());
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect((error.cause as AggregateError).errors).toEqual([closeError, siblingCloseError]);
    expect(error.details).toMatchObject({ publication: { status: "published" }, cleanup: "preserved", resources: "close-failed" });
    expect(sourceCloses).toBe(1);
    expect(siblingClose).toHaveBeenCalledOnce();
    expect(recycled).toBe(f.fd);
    expect(fs.fstatSync(recycled).isFile()).toBe(true);
    expect(fs.readFileSync(f.targetPath, "utf8")).toBe("producer");
    expect(fs.readFileSync(f.sourcePath, "utf8")).toBe("producer");
  } finally {
    if (recycled !== -1) close(recycled);
  }
});
