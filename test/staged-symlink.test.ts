import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retainSymlinkInDirectory, type StagedSymlinkExpected } from "../src/advanced.js";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const supported = process.platform === "linux" || process.platform === "darwin";
let binding: NativeBinding | undefined;
try { binding = __loadBundledNativeForTest(); } catch {
  if (supported && process.env.FS_SAFE_NATIVE_MODE === "require") throw new Error("native binding required");
}
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

function capture(directory: string, name = "stage") {
  const stat = fs.lstatSync(path.join(directory, name), { bigint: true });
  return { dev: stat.dev, ino: stat.ino, uid: Number(stat.uid), gid: Number(stat.gid),
    ctimeNs: stat.ctimeNs, target: fs.readlinkSync(path.join(directory, name)) } satisfies StagedSymlinkExpected;
}
async function fixture(assertBeforeMutation = () => {}) {
  const directory = await tempRoot("fs-safe-symlink-");
  fs.mkdirSync(path.join(directory, "runtime"));
  fs.writeFileSync(path.join(directory, "runtime", "sentinel"), "untouched");
  fs.symlinkSync("runtime", path.join(directory, "stage"));
  const expected = capture(directory);
  const owner = await retainSymlinkInDirectory({ directory, basename: "stage", expected, assertBeforeMutation });
  return { directory, expected, owner };
}
function replace(directory: string, name: string) {
  fs.renameSync(path.join(directory, name), path.join(directory, "original"));
  fs.symlinkSync("runtime", path.join(directory, name));
  return fs.lstatSync(path.join(directory, name), { bigint: true });
}
function identity(directory: string, name: string) {
  const { dev, ino } = fs.lstatSync(path.join(directory, name), { bigint: true });
  return { dev, ino };
}

for (const unavailable of ["off", "absent", "missing-capability", "windows"] as const) {
  it(`refuses ${unavailable} without namespace mutation`, async () => {
    const directory = await tempRoot("fs-safe-link-unavailable-");
    fs.writeFileSync(path.join(directory, "sentinel"), "untouched");
    if (unavailable === "off") configureFsSafeNative({ mode: "off" });
    if (unavailable === "absent") __setNativeLoaderForTest(() => { throw new Error("unavailable"); });
    if (unavailable === "missing-capability") __setNativeLoaderForTest(() => ({ closeOwnedFd() {} }) as never);
    if (unavailable === "windows") vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await expect(retainSymlinkInDirectory({
      directory, basename: "stage", expected: { dev: 1n, ino: 1n, uid: 0, gid: 0, ctimeNs: 0n, target: "runtime" },
      assertBeforeMutation() {},
    })).rejects.toMatchObject({ code: process.platform === "win32" ? "unsupported-platform" : "helper-unavailable" });
    expect(fs.readdirSync(directory)).toEqual(["sentinel"]);
    expect(fs.readFileSync(path.join(directory, "sentinel"), "utf8")).toBe("untouched");
  });
}

describe.runIf(supported && !!binding)("retained staged symlink", () => {
  it("publishes the captured inode, keeps a frozen receipt and never cleans the final name", async () => {
    const { directory, expected, owner } = await fixture();
    try {
      expect(Object.keys(owner)).toEqual([]);
      expect(Object.isFrozen(owner.receipt)).toBe(true);
      expect(Object.isFrozen(owner.receipt.identity)).toBe(true);
      expect(owner.receipt).toMatchObject({ target: "runtime", identity: { dev: expected.dev, ino: expected.ino } });
      await owner.assertCurrent();
      const publication = await owner.publish("slot");
      expect(publication).toMatchObject({ status: "published", overwrite: false, staged: owner.receipt });
      expect(identity(directory, "slot")).toEqual({ dev: expected.dev, ino: expected.ino });
      expect(fs.readlinkSync(path.join(directory, "slot"))).toBe("runtime");
      expect(fs.existsSync(path.join(directory, "stage"))).toBe(false);
      await owner.assertPublished();
      expect(await owner.cleanup()).toMatchObject({ status: "not-needed", resources: "closed", publication });
      await expect(owner.assertPublished()).rejects.toMatchObject({ code: "helper-failed" });
      expect(identity(directory, "slot")).toEqual({ dev: expected.dev, ino: expected.ino });
    } finally { await owner.cleanup(); }
  });

  it.each(["inode", "target", "ownership", "ctime", "async-authority"])("refuses %s admission and never unlinks the supplied name", async (kind) => {
    const directory = await tempRoot("fs-safe-link-admission-");
    fs.symlinkSync("runtime", path.join(directory, "stage"));
    const expected = capture(directory);
    if (kind === "inode") replace(directory, "stage");
    if (kind === "target") expected.target = "different";
    if (kind === "ownership") expected.uid += 1;
    if (kind === "ctime") expected.ctimeNs += 1n;
    const before = identity(directory, "stage");
    await expect(retainSymlinkInDirectory({
      directory, basename: "stage", expected,
      assertBeforeMutation: kind === "async-authority" ? async () => {} : () => {},
    })).rejects.toMatchObject({ details: { phase: "prepare", publication: { status: "not-published" } } });
    expect(identity(directory, "stage")).toEqual(before);
  });

  it.each(["file", "directory", "symlink-hardlink"])("rejects %s instead of retaining it as an exclusive symlink", async (kind) => {
    const directory = await tempRoot("fs-safe-link-type-");
    const name = path.join(directory, "stage");
    if (kind === "file") fs.writeFileSync(name, "sentinel");
    else if (kind === "directory") fs.mkdirSync(name);
    else {
      fs.symlinkSync("runtime", name);
      const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { binding!.linkBeneath(parent, "stage", parent, "alias"); }
      finally { fs.closeSync(parent); }
      expect(fs.lstatSync(name, { bigint: true }).nlink).toBe(2n);
    }
    const stat = fs.lstatSync(name, { bigint: true });
    await expect(retainSymlinkInDirectory({
      directory, basename: "stage",
      expected: { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs, uid: Number(stat.uid), gid: Number(stat.gid), target: "runtime" },
      assertBeforeMutation() {},
    })).rejects.toMatchObject({ details: { phase: "prepare" } });
    expect(identity(directory, "stage")).toEqual({ dev: stat.dev, ino: stat.ino });
  });

  it.each(["file", "symlink", "directory"])("refuses a raced-in %s at the exact slot without nesting or overwriting", async (kind) => {
    const publish = binding!.publishStagedSymlink!;
    let before: ReturnType<typeof identity>;
    const { directory, owner } = await fixture();
    vi.spyOn(binding!, "publishStagedSymlink").mockImplementation((...args) => {
      const slot = path.join(directory, "slot");
      if (kind === "file") fs.writeFileSync(slot, "foreign");
      else if (kind === "symlink") fs.symlinkSync("runtime", slot);
      else fs.mkdirSync(slot);
      before = identity(directory, "slot");
      return publish(...args);
    });
    try {
      await expect(owner.publish("slot")).rejects.toMatchObject({
        code: "already-exists", details: { publication: { status: "indeterminate" } },
      });
      expect(identity(directory, "slot")).toEqual(before!);
      if (kind === "directory") expect(fs.readdirSync(path.join(directory, "slot"))).toEqual([]);
      if (kind === "file") expect(fs.readFileSync(path.join(directory, "slot"), "utf8")).toBe("foreign");
      if (kind === "symlink") expect(fs.readlinkSync(path.join(directory, "slot"))).toBe("runtime");
      await expect(owner.publish("retry")).rejects.toMatchObject({ details: { publication: { status: "indeterminate" } } });
      expect(await owner.cleanup()).toMatchObject({ status: "preserved", resources: "closed" });
      expect(fs.lstatSync(path.join(directory, "stage")).isSymbolicLink()).toBe(true);
    } finally { await owner.cleanup(); }
  });

  it.each(["before-js-check", "at-native-dispatch"])("preserves same-target source substitution %s", async (point) => {
    const { directory, owner } = await fixture();
    const publish = binding!.publishStagedSymlink!;
    if (point === "before-js-check") replace(directory, "stage");
    else vi.spyOn(binding!, "publishStagedSymlink").mockImplementation((...args) => {
      replace(directory, "stage");
      return publish(...args);
    });
    try {
      await expect(owner.publish("slot")).rejects.toMatchObject({ details: { publication: { status: "not-published" } } });
      const foreign = identity(directory, "stage");
      expect(await owner.cleanup()).toMatchObject({ status: "preserved", resources: "closed" });
      expect(identity(directory, "stage")).toEqual(foreign);
      expect(fs.existsSync(path.join(directory, "slot"))).toBe(false);
      await expect(owner[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "not-removable" });
    } finally { await owner.cleanup(); }
  });

  it("records publication before a same-target foreign replacement fails postchecks and recovery", async () => {
    let held = -1;
    const open = binding!.openStagedSymlink!;
    vi.spyOn(binding!, "openStagedSymlink").mockImplementation((...args) => (held = open(...args)));
    const { directory, expected, owner } = await fixture();
    const publish = binding!.publishStagedSymlink!;
    vi.spyOn(binding!, "publishStagedSymlink").mockImplementation((...args) => {
      publish(...args);
      replace(directory, "slot");
    });
    try {
      await expect(owner.publish("slot")).rejects.toMatchObject({
        details: { publication: { status: "published", staged: owner.receipt } },
      });
      const foreign = identity(directory, "slot");
      expect(foreign.ino).not.toBe(expected.ino);
      expect(fs.fstatSync(held, { bigint: true }).ino).toBe(expected.ino);
      await expect(owner.assertPublished()).rejects.toMatchObject({ code: "path-mismatch" });
      expect(await owner.removePublished()).toBe("preserved");
      expect(identity(directory, "slot")).toEqual(foreign);
      expect(await owner.cleanup()).toMatchObject({ status: "not-needed", resources: "closed" });
      expect(() => fs.fstatSync(held)).toThrow();
      expect(identity(directory, "slot")).toEqual(foreign);
    } finally { await owner.cleanup(); }
  });

  it("preserves ambiguous committed publication and prevents retry or automatic removal", async () => {
    const { directory, expected, owner } = await fixture();
    const publish = binding!.publishStagedSymlink!;
    vi.spyOn(binding!, "publishStagedSymlink").mockImplementation((...args) => {
      publish(...args);
      throw Object.assign(new Error("reply lost"), { code: "EIO" });
    });
    try {
      await expect(owner.publish("slot")).rejects.toMatchObject({ details: { publication: { status: "indeterminate" } } });
      await expect(owner.removePublished()).rejects.toMatchObject({ code: "helper-failed" });
      expect(await owner.cleanup()).toMatchObject({ status: "preserved" });
      expect(identity(directory, "slot")).toEqual({ dev: expected.dev, ino: expected.ino });
    } finally { await owner.cleanup(); }
  });

  it.each(["before", "after"])("retains original parent when it is replaced %s dispatch", async (point) => {
    const base = await tempRoot("fs-safe-link-parent-");
    const directory = path.join(base, "parent");
    const moved = path.join(base, "moved");
    fs.mkdirSync(directory);
    fs.symlinkSync("runtime", path.join(directory, "stage"));
    let armed = false;
    const swap = () => {
      fs.renameSync(directory, moved);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "stage"), "foreign stage");
      fs.writeFileSync(path.join(directory, "slot"), "foreign slot");
    };
    const owner = await retainSymlinkInDirectory({
      directory, basename: "stage", expected: capture(directory),
      assertBeforeMutation() { if (armed && point === "before") { armed = false; swap(); } },
    });
    if (point === "after") {
      const publish = binding!.publishStagedSymlink!;
      vi.spyOn(binding!, "publishStagedSymlink").mockImplementation((...args) => { publish(...args); swap(); });
    }
    armed = true;
    try {
      await expect(owner.publish("slot")).rejects.toMatchObject({
        details: { publication: { status: point === "before" ? "not-published" : "published" } },
      });
      expect(await owner.cleanup()).toMatchObject({ status: point === "before" ? "removed" : "not-needed" });
      expect(fs.readdirSync(moved)).toEqual(point === "before" ? [] : ["slot"]);
      expect(fs.readFileSync(path.join(directory, "stage"), "utf8")).toBe("foreign stage");
      expect(fs.readFileSync(path.join(directory, "slot"), "utf8")).toBe("foreign slot");
    } finally { await owner.cleanup(); }
  });

  it("requires current synchronous authority for publication, recovery and cleanup", async () => {
    let allowed = true;
    const { directory, owner } = await fixture(() => { if (!allowed) throw new Error("expired"); });
    allowed = false;
    await expect(owner.publish("slot")).rejects.toMatchObject({ details: { publication: { status: "not-published" } } });
    await expect(owner.cleanup()).rejects.toMatchObject({ details: { cleanup: { status: "failed", resources: "closed" } } });
    expect(fs.readdirSync(directory).sort()).toEqual(["runtime", "stage"]);
    allowed = true;
    await expect(owner.cleanup()).rejects.toMatchObject({ details: { cleanup: { resources: "closed" } } });
  });

  it("explicitly removes only the retained published symlink and caches recovery settlement", async () => {
    const { directory, owner } = await fixture();
    try {
      await owner.publish("slot");
      expect(await owner.removePublished()).toBe("removed");
      fs.symlinkSync("runtime", path.join(directory, "slot"));
      const foreign = identity(directory, "slot");
      expect(await owner.removePublished()).toBe("removed");
      expect(identity(directory, "slot")).toEqual(foreign);
      expect(fs.readFileSync(path.join(directory, "runtime", "sentinel"), "utf8")).toBe("untouched");
    } finally { await owner.cleanup(); }
  });

  it("settles all handles once after failed removal without retrying through recycled descriptors", async () => {
    let held = -1;
    const open = binding!.openStagedSymlink!;
    vi.spyOn(binding!, "openStagedSymlink").mockImplementation((...args) => (held = open(...args)));
    const { owner } = await fixture();
    const remove = vi.spyOn(binding!, "removeStagedSymlink").mockImplementation(() => { throw new Error("I/O"); });
    await expect(owner.cleanup()).rejects.toMatchObject({ details: { cleanup: { status: "failed", resources: "closed" } } });
    expect(() => fs.fstatSync(held)).toThrow();
    await expect(owner.cleanup()).rejects.toBeTruthy();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid names without consuming the stage, then serializes publish and close", async () => {
    const { directory, owner } = await fixture();
    try {
      for (const name of ["", ".", "..", "a/b", "a\\b", "C:slot", "a\0b", "bad\nname", "stage"]) {
        await expect(owner.publish(name)).rejects.toMatchObject({ code: "invalid-path" });
      }
      await owner.assertCurrent();
      const results = await Promise.allSettled([owner.publish("slot"), owner.cleanup(), owner.publish("other")]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
      expect(fs.readdirSync(directory).sort()).toEqual(["runtime", "slot"]);
    } finally { await owner.cleanup(); }
  });

  it.each(["owned", "absent"])("settles an unpublished %s stage and closes its retained descriptor", async (kind) => {
    let held = -1;
    const open = binding!.openStagedSymlink!;
    vi.spyOn(binding!, "openStagedSymlink").mockImplementation((...args) => (held = open(...args)));
    const { directory, owner } = await fixture();
    try {
      if (kind === "absent") fs.unlinkSync(path.join(directory, "stage"));
      const result = await owner.cleanup();
      expect(result).toMatchObject({ status: kind === "owned" ? "removed" : "name-absent", resources: "closed" });
      expect(() => fs.fstatSync(held)).toThrow();
      await owner[Symbol.asyncDispose]();
      expect(await owner.cleanup()).toBe(result);
      expect(fs.readdirSync(directory)).toEqual(["runtime"]);
    } finally { await owner.cleanup(); }
  });

  it("refuses recovery after authority expires, preserves the published inode and never retries", async () => {
    let allowed = true;
    const { directory, owner, expected } = await fixture(() => { if (!allowed) throw new Error("expired"); });
    try {
      await owner.publish("slot");
      allowed = false;
      await expect(owner.removePublished()).rejects.toMatchObject({ details: { phase: "remove-published", publication: { status: "published" } } });
      allowed = true;
      await expect(owner.removePublished()).rejects.toMatchObject({ details: { phase: "remove-published" } });
      expect(identity(directory, "slot")).toEqual({ dev: expected.dev, ino: expected.ino });
    } finally { await owner.cleanup(); }
  });

  it("checks authority callback source changes again before publication", async () => {
    let armed = false;
    let directoryToReplace = "";
    const { directory, owner } = await fixture(() => { if (armed) { armed = false; replace(directoryToReplace, "stage"); } });
    directoryToReplace = directory;
    armed = true;
    try {
      await expect(owner.publish("slot")).rejects.toMatchObject({ details: { publication: { status: "not-published" } } });
      expect(await owner.cleanup()).toMatchObject({ status: "preserved" });
      expect(fs.readlinkSync(path.join(directory, "stage"))).toBe("runtime");
      expect(fs.existsSync(path.join(directory, "slot"))).toBe(false);
    } finally { await owner.cleanup(); }
  });

  it("rejects native negative and closed descriptors without changing names", async () => {
    const { directory, owner } = await fixture();
    const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const link = binding!.openStagedSymlink!(parent, "stage");
    try {
      for (const fd of [-1, -100]) {
        expect(() => binding!.openStagedSymlink!(fd, "stage")).toThrow();
        expect(() => binding!.stagedSymlinkTarget!(parent, "stage", fd)).toThrow();
        expect(() => binding!.stagedSymlinkMatches!(fd, "stage", link)).toThrow();
        expect(() => binding!.publishStagedSymlink!(parent, "stage", fd, "slot")).toThrow();
        expect(() => binding!.removeStagedSymlink!(fd, "stage", link)).toThrow();
      }
      for (const name of ["../stage", "a/stage", ".", ""]) {
        expect(() => binding!.openStagedSymlink!(parent, name)).toThrow();
        expect(() => binding!.publishStagedSymlink!(parent, "stage", link, name)).toThrow();
      }
    } finally { binding!.closeOwnedFd!(link); fs.closeSync(parent); }
    expect(() => binding!.openStagedSymlink!(parent, "stage")).toThrow();
    expect(fs.readdirSync(directory).sort()).toEqual(["runtime", "stage"]);
    await owner.cleanup();
  });

  it("rejects callback reentrancy without closing the in-flight publication descriptors", async () => {
    let nested: Promise<unknown> | undefined;
    let armed = false;
    const { directory, owner } = await fixture(() => {
      if (armed) nested = owner.cleanup().catch((error: unknown) => error);
    });
    armed = true;
    try {
      await owner.publish("slot");
      expect(await nested).toMatchObject({ code: "helper-failed" });
      await owner.assertPublished();
      expect(fs.readlinkSync(path.join(directory, "slot"))).toBe("runtime");
    } finally { await owner.cleanup(); }
  });
});
