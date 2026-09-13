import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-recursive-remove-race-");
  const tree = path.join(directory, "tree");
  await fs.mkdir(tree);
  await fs.writeFile(path.join(tree, "first"), "first");
  await fs.writeFile(path.join(tree, "second"), "second");
  return { directory, tree, scoped: await root(directory) };
}

it.each(["authority", "abort"] as const)("settles an admitted unlink and stops after %s expires", async refusal => {
  const { tree, scoped } = await fixture();
  const expired = Object.assign(new Error("removal owner expired"), { code: "ENOENT" });
  const controller = new AbortController();
  let revoked = false;
  let removals = 0;
  let closed = 0;
  let settled = false;
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation(async target => {
    await unlink(target);
    removals += 1;
    revoked = true;
    if (refusal === "abort") controller.abort(expired);
    await new Promise<void>(resolve => setImmediate(resolve));
    settled = true;
  });
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed += 1; });
    return handle;
  });
  await expect(scoped.remove("tree", {
    recursive: true,
    force: true,
    signal: controller.signal,
    assertBeforeMutation: () => { if (refusal === "authority" && revoked) throw expired; },
  })).rejects.toBe(expired);
  expect(settled).toBe(true);
  expect(removals).toBe(1);
  expect(closed).toBe(1);
  expect(await fs.readdir(tree)).toHaveLength(1);
});

it("does no filesystem work when removal is already canceled", async () => {
  const { scoped } = await fixture();
  const opendir = vi.spyOn(fs, "opendir");
  const lstat = vi.spyOn(fsSync, "lstatSync");
  const reason = Object.assign(new Error("canceled"), { code: "ENOENT" });
  await expect(scoped.remove("tree", { recursive: true, force: true, signal: AbortSignal.abort(reason) }))
    .rejects.toBe(reason);
  expect(opendir).not.toHaveBeenCalled();
  expect(lstat).not.toHaveBeenCalled();
});

it.each([false, true].flatMap(recursive => ["file", "directory"].map(kind => ({ recursive, kind }))))(
  "propagates cancellation after the final $kind removal settles (recursive=$recursive)", async ({ recursive, kind }) => {
    const directory = await tempRoot("fs-safe-remove-final-abort-");
    const target = path.join(directory, "target");
    if (kind === "file") await fs.writeFile(target, "value");
    else await fs.mkdir(target);
    const scoped = await root(directory);
    const controller = new AbortController();
    const reason = new Error("canceled during final removal");
    const method = kind === "file" ? "unlink" : "rmdir";
    const remove = fs[method].bind(fs);
    vi.spyOn(fs, method).mockImplementation(async path => {
      await remove(path);
      controller.abort(reason);
    });
    await expect(scoped.remove("target", { recursive, signal: controller.signal })).rejects.toBe(reason);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("retains intermediate ancestor identities when the immediate parent is moved into a replacement", async () => {
  const directory = await tempRoot("fs-safe-remove-intermediate-ancestor-");
  await fs.mkdir(path.join(directory, "a/b"), { recursive: true });
  await fs.writeFile(path.join(directory, "a/b/value"), "preserve");
  const scoped = await root(directory);
  let changed = false;
  __setFsSafeTestHooksForTest({
    async beforeRootFallbackMutation(operation) {
      if (operation !== "remove" || changed) return;
      changed = true;
      await fs.rename(path.join(directory, "a"), path.join(directory, "saved-a"));
      await fs.mkdir(path.join(directory, "a"));
      await fs.rename(path.join(directory, "saved-a/b"), path.join(directory, "a/b"));
    },
  });
  // A file target keeps Windows directory enumeration handles out of the rename fixture.
  await expect(scoped.remove("a/b/value", { recursive: true, force: true })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(changed).toBe(true);
  expect(await fs.readFile(path.join(directory, "a/b/value"), "utf8")).toBe("preserve");
});

it.each([false, true])("stops after a missing parent even if an escaping link appears (force=%s)", async force => {
  const directory = await tempRoot("fs-safe-remove-missing-parent-");
  const outside = await tempRoot("fs-safe-remove-missing-parent-outside-");
  await fs.writeFile(path.join(outside, "value"), "outside");
  const scoped = await root(directory);
  const missingParent = path.join(directory, "missing");
  let introduced = false;
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    try {
      return lstat(...args);
    } catch (error) {
      const options = args[1];
      if (!introduced && String(args[0]) === missingParent && typeof options === "object" && options?.bigint) {
        introduced = true;
        fsSync.symlinkSync(outside, missingParent, process.platform === "win32" ? "junction" : "dir");
      }
      throw error;
    }
  });
  const pending = scoped.remove("missing/value", { recursive: true, force });
  if (force) await pending;
  else await expect(pending).rejects.toMatchObject({ code: "not-found" });
  expect(introduced).toBe(true);
  expect(await fs.readFile(path.join(outside, "value"), "utf8")).toBe("outside");
});

it("does not suppress cancellation when final preparation removes a tolerated missing target", async () => {
  const directory = await tempRoot("fs-safe-remove-missing-abort-");
  await fs.writeFile(path.join(directory, "target"), "value");
  const scoped = await root(directory);
  const controller = new AbortController();
  const reason = Object.assign(new Error("canceled after competing removal"), { code: "ENOENT" });
  __setFsSafeTestHooksForTest({
    async beforeRootFallbackMutation(operation, target) {
      if (operation !== "remove") return;
      await fs.unlink(target);
      controller.abort(reason);
    },
  });
  await expect(scoped.remove("target", { recursive: true, force: true, signal: controller.signal })).rejects.toBe(reason);
});

it.each([false, true])("handles a directory disappearing before its guard is admitted (force=%s)", async force => {
  const directory = await tempRoot("fs-safe-remove-vanished-directory-");
  const target = path.join(directory, "target");
  await fs.mkdir(target);
  const scoped = await root(directory);
  let removed = false;
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    const options = args[1];
    if (!removed && String(args[0]) === target && typeof options === "object" && options?.bigint) {
      removed = true;
      queueMicrotask(() => fsSync.rmdirSync(target));
    }
    return stat;
  });
  const pending = scoped.remove("target", { recursive: true, force });
  if (force) await pending;
  else await expect(pending).rejects.toMatchObject({ code: "not-found" });
  expect(removed).toBe(true);
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a replacement file observed during awaited removal preparation", async () => {
  const { directory, tree, scoped } = await fixture();
  let replaced: string | undefined;
  __setFsSafeTestHooksForTest({
    async beforeRootFallbackMutation(operation, target) {
      if (operation !== "remove" || path.dirname(target) !== tree || replaced) return;
      replaced = target;
      await fs.rename(target, path.join(directory, "saved"));
      await fs.writeFile(target, "replacement");
    },
  });
  await expect(scoped.remove("tree", { recursive: true, force: true })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(replaced).toBeDefined();
  expect(await fs.readFile(replaced!, "utf8")).toBe("replacement");
  expect(await fs.readdir(tree)).toHaveLength(2);
});

it.each(["replaced", "symlink", "missing"] as const)("refuses a %s ancestor after directory read", async replacement => {
  const { directory, tree, scoped } = await fixture();
  const outside = await tempRoot("fs-safe-remove-race-outside-");
  await fs.writeFile(path.join(outside, "first"), "outside");
  const saved = path.join(directory, "saved");
  let changed = false;
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async () => {
      const entry = await read();
      if (!changed && entry) {
        changed = true;
        await fs.rename(tree, saved);
        if (replacement === "replaced") {
          await fs.mkdir(tree);
          await fs.writeFile(path.join(tree, "first"), "replacement");
        } else if (replacement === "symlink") {
          await fs.symlink(outside, tree, process.platform === "win32" ? "junction" : "dir");
        }
      }
      return entry;
    });
    return handle;
  });
  await expect(scoped.remove("tree", { recursive: true, force: true })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(changed).toBe(true);
  expect((await fs.readdir(saved)).sort()).toEqual(["first", "second"]);
  expect(await fs.readFile(path.join(outside, "first"), "utf8")).toBe("outside");
  if (replacement === "replaced") expect(await fs.readFile(path.join(tree, "first"), "utf8")).toBe("replacement");
});

it("does not round the identity of a leaf before removal", async () => {
  const { tree, scoped } = await fixture();
  let changed: string | undefined;
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (path.dirname(String(args[0])) === tree && typeof stat.ino === "bigint") {
      return Object.assign(stat, { ino: 2n ** 54n + (String(args[0]) === changed ? 1n : 0n) });
    }
    return stat;
  });
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation(operation, target) {
      if (operation === "remove" && path.dirname(target) === tree) changed = target;
    },
  });
  await expect(scoped.remove("tree", { recursive: true })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(await fs.readdir(tree)).toHaveLength(2);
});

it.each(["opendir", "read"] as const)("maps %s permission failures to the removal error contract", async phase => {
  const { tree, scoped } = await fixture();
  const denied = Object.assign(new Error("directory access denied"), { code: "EACCES" });
  let closed = 0;
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    if (phase === "opendir") throw denied;
    const handle = await opendir(...args);
    vi.spyOn(handle, "read").mockRejectedValueOnce(denied);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed += 1; });
    return handle;
  });
  await expect(scoped.remove("tree", { recursive: true, force: true })).rejects.toMatchObject({
    code: "not-removable", cause: denied,
  });
  expect(closed).toBe(phase === "read" ? 1 : 0);
  expect((await fs.readdir(tree)).sort()).toEqual(["first", "second"]);
});

it.each(["abort", "read", "close"] as const)("retains disposal failures after %s and closes before removing directories", async failure => {
  const { tree, scoped } = await fixture();
  const controller = new AbortController();
  const primary = Object.assign(new Error("operation failed"), { code: "EACCES" });
  const closeFailure = Object.assign(new Error("close failed"), { code: "EIO" });
  let closeAttempts = 0;
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closeAttempts += 1;
      await close();
      throw closeFailure;
    });
    if (failure === "abort") controller.abort(primary);
    if (failure === "read") vi.spyOn(handle, "read").mockRejectedValueOnce(primary);
    return handle;
  });
  const pending = scoped.remove("tree", { recursive: true, signal: controller.signal });
  const normalizedClose = { code: "not-removable", cause: closeFailure };
  if (failure === "close") await expect(pending).rejects.toMatchObject(normalizedClose);
  else await expect(pending).rejects.toMatchObject({
    name: "SuppressedError",
    error: normalizedClose,
    suppressed: failure === "read" ? { code: "not-removable", cause: primary } : primary,
  });
  expect(closeAttempts).toBe(1);
  expect((await fs.stat(tree)).isDirectory()).toBe(true);
});
