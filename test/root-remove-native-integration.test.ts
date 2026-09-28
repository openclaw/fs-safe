import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Dedicated native lanes build the addon. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

it("keeps auto removal on its existing path even with native removal available", async () => {
  const nativeMutation = vi.fn(() => { throw new Error("require-only primitive"); });
  __setNativeLoaderForTest(() => ({ ...native, rootRemovalStat: nativeMutation, rootRemovalUnlink: nativeMutation } as unknown as NativeBinding));
  configureFsSafeNative({ mode: "auto" });
  const directory = await tempRoot("fs-safe-auto-remove-");
  await fs.mkdir(path.join(directory, "tree"));
  await fs.writeFile(path.join(directory, "value"), "inside");
  await fs.writeFile(path.join(directory, "tree/value"), "inside");
  const scoped = await root(directory);
  await scoped.remove("value");
  await scoped.remove("tree", { recursive: true });
  expect(await fs.readdir(directory)).toEqual([]);
  expect(nativeMutation).not.toHaveBeenCalled();
});

describe.runIf(native?.rootRemovalStat)("native Root removal", () => {
  function requireNative(): void {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
  }

  it("normalizes a root-descriptor admission failure before recursive removal", async () => {
    requireNative();
    const directory = await tempRoot("fs-safe-native-remove-root-error-");
    await fs.mkdir(path.join(directory, "tree"));
    const scoped = await root(directory);
    vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(scoped.remove("tree", { recursive: true })).rejects.toMatchObject({ code: "path-alias" });
    expect(await fs.readdir(directory)).toEqual(["tree"]);
  });

  it.skipIf(process.platform !== "win32")("fails closed for unsupported Windows recursive directories", async () => {
    requireNative();
    const directory = await tempRoot("fs-safe-native-remove-windows-tree-");
    await fs.mkdir(path.join(directory, "tree"));
    await fs.writeFile(path.join(directory, "tree/value"), "preserve");
    const scoped = await root(directory);
    await expect(scoped.remove("tree", { recursive: true })).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(await fs.readFile(path.join(directory, "tree/value"), "utf8")).toBe("preserve");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not require directory read permission to unlink a direct child", async () => {
    requireNative();
    const directory = await tempRoot("fs-safe-native-remove-search-");
    const parent = path.join(directory, "parent");
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, "value"), "inside");
    const scoped = await root(directory);
    await fs.chmod(parent, 0o300);
    await fs.chmod(directory, 0o300);
    try { await scoped.remove("parent/value"); }
    finally { await fs.chmod(directory, 0o700); await fs.chmod(parent, 0o700); }
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it.each(native?.openRootRemovalDirectory ? [false, true] : [false])("keeps outside data after a parent swap (recursive=%s)", async recursive => {
    requireNative();
    const directory = await tempRoot("fs-safe-native-remove-");
    const outside = await tempRoot("fs-safe-native-remove-outside-");
    await fs.mkdir(path.join(directory, "parent/tree"), { recursive: true });
    await fs.mkdir(path.join(outside, "tree"));
    await fs.writeFile(path.join(directory, "parent/tree/value"), "inside");
    await fs.writeFile(path.join(outside, "tree/value"), "outside");
    const scoped = await root(directory);
    let swapped = false;
    __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async operation => {
      if (operation !== "remove" || swapped) return;
      await fs.rename(path.join(directory, "parent"), path.join(directory, "held"));
      await fs.symlink(outside, path.join(directory, "parent"), process.platform === "win32" ? "junction" : "dir");
      swapped = true;
    } });
    await expect(scoped.remove(recursive ? "parent/tree" : "parent/tree/value", { recursive }))
      .rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    expect(await fs.readFile(path.join(outside, "tree/value"), "utf8")).toBe("outside");
  });

  it.skipIf(!native?.openRootRemovalDirectory).each(["filesystem", "sorted"] as const)("preserves recursive policies and budgets (%s)", async order => {
    requireNative();
    const directory = await tempRoot("fs-safe-native-remove-policy-");
    await fs.mkdir(path.join(directory, "tree/nested"), { recursive: true });
    await fs.writeFile(path.join(directory, "tree/nested/value"), "preserve");
    const scoped = await root(directory);
    await expect(scoped.remove("tree", { recursive: true, order, denyMutations: { paths: [path.join(directory, "tree/nested/value")] } }))
      .rejects.toMatchObject({ code: "denied-path" });
    await expect(scoped.remove("tree", { recursive: true, order, maxEntries: 2 }))
      .rejects.toMatchObject({ code: "too-large" });
    expect(await fs.readFile(path.join(directory, "tree/nested/value"), "utf8")).toBe("preserve");
    await scoped.remove("tree", { recursive: true, order, maxEntries: 3 });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("fails closed before mutation when mount-bounded descent is unavailable", async () => {
    __setNativeLoaderForTest(() => ({ ...native!, openRootRemovalDirectory() {
      throw Object.assign(new Error("unavailable"), { code: "ENOTSUP" });
    } }));
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-remove-unavailable-");
    await fs.mkdir(path.join(directory, "tree"));
    const scoped = await root(directory);
    await expect(scoped.remove("tree", { recursive: true })).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(await fs.readdir(directory)).toEqual(["tree"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not confuse an unreadable parent with an unavailable recursive primitive", async () => {
    requireNative();
    const directory = await tempRoot("fs-safe-native-remove-recursive-search-");
    const parent = path.join(directory, "parent");
    await fs.mkdir(path.join(parent, "tree"), { recursive: true });
    await fs.writeFile(path.join(parent, "tree/value"), "inside");
    const scoped = await root(directory);
    await fs.chmod(parent, 0o300);
    try { await scoped.remove("parent/tree", { recursive: true }); }
    finally { await fs.chmod(parent, 0o700); }
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("checks the retained ancestor identities after native unlink dispatch", async () => {
    const directory = await tempRoot("fs-safe-native-remove-after-");
    await fs.mkdir(path.join(directory, "ancestor/parent"), { recursive: true });
    await fs.writeFile(path.join(directory, "ancestor/parent/value"), "inside");
    const scoped = await root(directory);
    __setNativeLoaderForTest(() => ({ ...native!, rootRemovalUnlink(...args) {
      native!.rootRemovalUnlink!(...args);
      // Preserve the immediate parent's identity beneath a replaced ancestor.
      fsSync.renameSync(path.join(directory, "ancestor"), path.join(directory, "held"));
      fsSync.mkdirSync(path.join(directory, "ancestor"));
      fsSync.renameSync(path.join(directory, "held/parent"), path.join(directory, "ancestor/parent"));
    } }));
    configureFsSafeNative({ mode: "require" });
    await expect(scoped.remove("ancestor/parent/value", { force: true })).rejects.toMatchObject({ code: "path-mismatch" });
  });

  it.skipIf(!native?.openRootRemovalDirectory).each([false, true])("preserves force semantics when a directory disappears before native open (force=%s)", async force => {
    const directory = await tempRoot("fs-safe-native-remove-force-");
    await fs.mkdir(path.join(directory, "tree"));
    const scoped = await root(directory);
    __setNativeLoaderForTest(() => ({ ...native!, openRootRemovalDirectory() {
      fsSync.rmdirSync(path.join(directory, "tree"));
      throw Object.assign(new Error("disappeared"), { code: "ENOENT" });
    } }));
    configureFsSafeNative({ mode: "require" });
    const pending = scoped.remove("tree", { recursive: true, force });
    if (force) await expect(pending).resolves.toBeUndefined();
    else await expect(pending).rejects.toMatchObject({ code: "not-found", details: {
      operation: "remove", phase: "enumerate", relativePath: "",
    } });
  });

  it.skipIf(!native?.openRootRemovalDirectory)("preserves native enumeration and close failures with their operation context", async () => {
    const directory = await tempRoot("fs-safe-native-remove-close-");
    await fs.mkdir(path.join(directory, "tree"));
    const readError = Object.assign(new Error("read denied"), { code: "EACCES" });
    const closeError = Object.assign(new Error("close failed"), { code: "EIO" });
    __setNativeLoaderForTest(() => ({ ...native!, openRootRemovalDirectory(...args) {
      const opened = native!.openRootRemovalDirectory!(...args);
      return { get fd() { return opened.fd; }, read() { throw readError; }, close() { opened.close(); throw closeError; } };
    } }));
    configureFsSafeNative({ mode: "require" });
    const scoped = await root(directory);
    await expect(scoped.remove("tree", { recursive: true })).rejects.toMatchObject({
      name: "SuppressedError",
      error: { code: "not-removable", cause: closeError },
      suppressed: { code: "not-removable", cause: readError, details: { operation: "remove", phase: "enumerate", relativePath: "" } },
    });
  });

  it.skipIf(!native?.openRootRemovalDirectory).each([false, true])("preserves a custom abort reason during native traversal (close failure=%s)", async closeFailure => {
    const directory = await tempRoot("fs-safe-native-remove-abort-");
    await fs.mkdir(path.join(directory, "tree"));
    await fs.writeFile(path.join(directory, "tree/value"), "preserve");
    const controller = new AbortController();
    const reason = Object.freeze({ revoked: true });
    const closeError = new Error("parent close failed");
    let injected = false;
    __setNativeLoaderForTest(() => ({ ...native!,
      openRootRemovalDirectory(...args) {
        const opened = native!.openRootRemovalDirectory!(...args);
        return { get fd() { return opened.fd; }, read() { const name = opened.read(); controller.abort(reason); return name; }, close() { opened.close(); } };
      },
      closeOwnedFd(fd) {
        native!.closeOwnedFd(fd);
        if (closeFailure && controller.signal.aborted && !injected) { injected = true; throw closeError; }
      },
    }));
    configureFsSafeNative({ mode: "require" });
    const scoped = await root(directory);
    const pending = scoped.remove("tree", { recursive: true, signal: controller.signal });
    if (closeFailure) await expect(pending).rejects.toMatchObject({ name: "SuppressedError", error: closeError, suppressed: reason });
    else await expect(pending).rejects.toBe(reason);
    expect(await fs.readFile(path.join(directory, "tree/value"), "utf8")).toBe("preserve");
  });
});

it("does not silently use pathname removal with an incomplete required binding", async () => {
  __setNativeLoaderForTest(() => ({ closeOwnedFd() {} }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("fs-safe-remove-require-");
  await fs.writeFile(path.join(directory, "value"), "preserve");
  const scoped = await root(directory);
  await expect(scoped.remove("value")).rejects.toMatchObject({ code: "helper-unavailable" });
  expect(await fs.readFile(path.join(directory, "value"), "utf8")).toBe("preserve");
});
