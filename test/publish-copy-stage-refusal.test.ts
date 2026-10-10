import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, root, type RootCopyPublicationReceipt } from "../src/index.js";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { FsSafeError } from "../src/errors.js";
import { publishCopyStage } from "../src/publish-copy-stage.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });
const errno = (code: string) => Object.assign(new Error(code), { code });
function refuse(code = "EACCES") {
  return vi.spyOn(fs, "linkSync").mockImplementation(() => { throw errno(code); });
}

async function fixture() {
  const directory = await tempRoot("fs-safe-link-refusal-");
  const temporaryPath = path.join(directory, "stage");
  const targetPath = path.join(directory, "target");
  fs.writeFileSync(temporaryPath, "complete bytes", { mode: 0o600 });
  const fd = fs.openSync(temporaryPath, "r");
  const params = { temporaryPath, targetPath, fd,
    identity: fs.fstatSync(fd, { bigint: true }),
    parentGuard: await createAsyncDirectoryGuard(directory, { bigint: true }) };
  return { ...params, directory, run: (callbacks: Partial<Parameters<typeof publishCopyStage>[0]> = {}) => {
    try { publishCopyStage({ ...params, ...callbacks }); } finally { fs.closeSync(fd); }
  } };
}

function afterClaim(targetPath: string, callback: () => void) {
  const open = fs.openSync;
  const close = fs.closeSync;
  let claimed: number | undefined;
  vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = open(...args);
    if (args[0] === targetPath) claimed = fd;
    return fd;
  });
  vi.spyOn(fs, "closeSync").mockImplementation(fd => {
    close(fd);
    if (fd === claimed) { claimed = undefined; callback(); }
  });
}

it.each(["EACCES", "EPERM"])("publishes copyIn and staged writes after %s without temporary names", async code => {
  const directory = await tempRoot("fs-safe-root-refusal-");
  const source = path.join(directory, "source");
  fs.writeFileSync(source, "snapshot bytes");
  const destination = path.join(directory, "destination");
  fs.mkdirSync(destination);
  const r = await root(destination);
  const link = refuse(code);
  const stages: BigIntStats[] = [];
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    stages.push(fs.lstatSync(from, { bigint: true }));
    expect(fs.lstatSync(to).size).toBe(0);
    rename(from, to);
  });
  let receipt: RootCopyPublicationReceipt | undefined;
  await r.copyIn("snap.sqlite", source, { overwrite: false, onDestinationPublished(value) { receipt = value; } });
  await r.create("atomic.txt", "atomic bytes", { atomic: true });
  await r.create("stream.txt", (async function* () { yield Buffer.from("stream bytes"); })());
  await r.write("write.txt", "buffered bytes", { overwrite: false });
  expect(link).toHaveBeenCalledTimes(3);
  for (const [index, name, content] of [[0, "snap.sqlite", "snapshot bytes"], [1, "atomic.txt", "atomic bytes"], [2, "stream.txt", "stream bytes"]] as const) {
    const stat = fs.lstatSync(path.join(destination, name), { bigint: true });
    expect(stat.ino).toBe(stages[index]!.ino);
    expect(stat.nlink).toBe(1n);
    expect(fs.readFileSync(path.join(destination, name), "utf8")).toBe(content);
  }
  expect(receipt).toMatchObject({ dev: stages[0]!.dev, ino: stages[0]!.ino });
  expect(fs.readFileSync(path.join(destination, "write.txt"), "utf8")).toBe("buffered bytes");
  expect(fs.readdirSync(destination).sort()).toEqual(["atomic.txt", "snap.sqlite", "stream.txt", "write.txt"]);
});

it.each(["pre-existing", "raced"])("preserves a %s destination", async when => {
  const f = await fixture();
  refuse();
  if (when === "pre-existing") fs.writeFileSync(f.targetPath, "winner");
  expect(() => f.run({ onPublicationAttempt() {
    if (when === "raced") fs.writeFileSync(f.targetPath, "winner");
  } })).toThrow(expect.objectContaining({ code: "already-exists" }));
  expect(fs.readFileSync(f.targetPath, "utf8")).toBe("winner");
  expect(fs.readFileSync(f.temporaryPath, "utf8")).toBe("complete bytes");
});

it.each(["file", "symlink", "directory", "modified", "missing"])("rejects a placeholder changed to %s and preserves foreign entries", async kind => {
  const f = await fixture();
  refuse();
  const foreign = path.join(f.directory, "foreign");
  fs.writeFileSync(foreign, "foreign bytes");
  afterClaim(f.targetPath, () => {
    if (kind === "modified") { fs.writeFileSync(f.targetPath, "foreign bytes"); return; }
    fs.renameSync(f.targetPath, path.join(f.directory, "claimed"));
    if (kind === "file") fs.renameSync(foreign, f.targetPath);
    if (kind === "symlink") fs.symlinkSync(foreign, f.targetPath);
    if (kind === "directory") fs.mkdirSync(f.targetPath);
  });
  expect(() => f.run()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  if (kind === "directory") expect(fs.lstatSync(f.targetPath).isDirectory()).toBe(true);
  else if (kind === "missing") expect(fs.existsSync(f.targetPath)).toBe(false);
  else expect(fs.readFileSync(f.targetPath, "utf8")).toBe("foreign bytes");
  if (kind === "symlink") expect(fs.lstatSync(f.targetPath).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(f.temporaryPath, "utf8")).toBe("complete bytes");
});

it("removes only its empty placeholder when rename fails", async () => {
  const f = await fixture();
  refuse();
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw errno("EIO"); });
  expect(() => f.run()).toThrow(expect.objectContaining({ code: "EIO" }));
  expect(fs.readdirSync(f.directory)).toEqual(["stage"]);
});

it("reports both operation and placeholder cleanup errors", async () => {
  const f = await fixture();
  refuse();
  const operation = errno("EIO"), cleanup = errno("EACCES");
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw operation; });
  vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw cleanup; });
  expect(() => f.run()).toThrow(expect.objectContaining({ code: "helper-failed",
    details: expect.objectContaining({ publication: "not-published", cleanup: "failed", path: f.targetPath }),
    cause: expect.objectContaining({ errors: [operation, cleanup] }) }));
  expect(fs.statSync(f.targetPath).size).toBe(0);
});

it("fails closed when exclusive creation itself is denied", async () => {
  const f = await fixture();
  refuse();
  vi.spyOn(fs, "openSync").mockImplementation(() => { throw errno("EACCES"); });
  const rename = vi.spyOn(fs, "renameSync");
  expect(() => f.run()).toThrow(expect.objectContaining({ code: "EACCES" }));
  expect(rename).not.toHaveBeenCalled();
  expect(fs.existsSync(f.targetPath)).toBe(false);
});

it.each(["EACCES", "EPERM"])("preserves a dangling Windows leaf introduced by link %s refusal", async (code, context) => {
  const f = await fixture();
  const referent = path.join(f.directory, "missing");
  const competitor = path.join(f.directory, "competitor");
  const link = await fileSymlinkOrSkip(referent, competitor, context);
  vi.spyOn(fs, "linkSync").mockImplementation(() => {
    fs.renameSync(competitor, f.targetPath);
    throw errno(code);
  });
  const open = vi.spyOn(fs, "openSync");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // Exercise the preflight on every host; Windows CI also proves real O_EXCL behavior.
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    expect(() => f.run()).toThrow(expect.objectContaining({ code: "already-exists" }));
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  expect(open).not.toHaveBeenCalled();
  expect(fs.readlinkSync(f.targetPath)).toBe(link);
  expect(fs.existsSync(referent)).toBe(false);
  expect(fs.readFileSync(f.temporaryPath, "utf8")).toBe("complete bytes");
});

it.each(["EIO", "EEXIST"])("does not fall back after link %s", async code => {
  const f = await fixture();
  refuse(code);
  const open = vi.spyOn(fs, "openSync");
  expect(() => f.run()).toThrow(expect.objectContaining({ code }));
  expect(open).not.toHaveBeenCalled();
  expect(fs.existsSync(f.targetPath)).toBe(false);
});

it("orders observers around publication and retains published content on observer failure", async () => {
  const f = await fixture();
  refuse();
  const observer = new Error("observer");
  expect(() => f.run({
    onPublicationAttempt() { expect(fs.existsSync(f.targetPath)).toBe(false); },
    onPublished(identity) {
      expect(fs.existsSync(f.temporaryPath)).toBe(false);
      expect(fs.lstatSync(f.targetPath, { bigint: true }).ino).toBe(identity.ino);
      throw observer;
    },
  })).toThrow(observer);
  expect(fs.readFileSync(f.targetPath, "utf8")).toBe("complete bytes");
});

it.each(["target", "stage"])("aggregates observer and post-rename %s verification failures without unlinking", async changed => {
  const f = await fixture();
  refuse();
  const observer = new Error("observer");
  let failure: unknown;
  try { f.run({ onPublished() {
    if (changed === "target") fs.renameSync(f.targetPath, path.join(f.directory, "published"));
    fs.writeFileSync(changed === "target" ? f.targetPath : f.temporaryPath, "foreign bytes");
    throw observer;
  } }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(FsSafeError);
  expect(failure).toMatchObject({ code: "helper-failed", details: { publication: "published", cleanup: "failed" },
    cause: { errors: [observer, expect.objectContaining({ code: "path-mismatch" })] } });
  expect(fs.readFileSync(changed === "target" ? f.targetPath : f.temporaryPath, "utf8")).toBe("foreign bytes");
});

it("revalidates the staged identity after claiming the placeholder", async () => {
  const f = await fixture();
  refuse();
  afterClaim(f.targetPath, () => {
    fs.renameSync(f.temporaryPath, path.join(f.directory, "held-stage"));
    fs.writeFileSync(f.temporaryPath, "foreign stage");
  });
  expect(() => f.run()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(fs.existsSync(f.targetPath)).toBe(false);
  expect(fs.readFileSync(f.temporaryPath, "utf8")).toBe("foreign stage");
});

it("reports unverifiable placeholder cleanup when its initial fstat fails", async () => {
  const f = await fixture();
  refuse();
  const fstat = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
    if (fd !== f.fd) throw errno("EIO");
    return fstat(fd, options);
  }) as typeof fs.fstatSync);
  expect(() => f.run()).toThrow(expect.objectContaining({ code: "helper-failed",
    details: { publication: "not-published", path: f.targetPath, cleanup: "failed" } }));
  expect(fs.statSync(f.targetPath).size).toBe(0);
  expect(fs.readFileSync(f.temporaryPath, "utf8")).toBe("complete bytes");
});
