import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native lanes build the binding. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => { configureFsSafeNative({ mode: "auto" }); __resetNativeLoaderForTest(); });

it("keeps auto overwrite move on its existing path with native replacement available", async () => {
  const nativeMutation = vi.fn(() => { throw new Error("require-only primitive"); });
  __setNativeLoaderForTest(() => ({ ...native, renameReplaceWithIdentity: nativeMutation } as unknown as NativeBinding));
  configureFsSafeNative({ mode: "auto" });
  const directory = await tempRoot("fs-safe-auto-move-");
  await fs.writeFile(path.join(directory, "source"), "inside");
  await fs.writeFile(path.join(directory, "target"), "old");
  const scoped = await root(directory);
  await scoped.move("source", "target", { overwrite: true });
  expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("inside");
  expect(nativeMutation).not.toHaveBeenCalled();
});

describe.runIf(native?.renameReplaceWithIdentity)("native overwrite Root move", () => {
  it.each([undefined, "follow-parents-within-root"] as const)("rechecks an original source alias after the authority callback (%s)", async mutationSymlinks => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-move-alias-");
    const outside = await tempRoot("fs-safe-native-move-alias-outside-");
    await fs.mkdir(path.join(directory, "actual"));
    await fs.writeFile(path.join(directory, "actual/source"), "inside");
    await fs.writeFile(path.join(outside, "source"), "outside");
    const alias = path.join(directory, "alias");
    const link = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(path.join(directory, "actual"), alias, link);
    const scoped = await root(directory);
    let swapped = false;
    await expect(scoped.move("alias/source", "target", { overwrite: true, mutationSymlinks, assertBeforeMutation() {
      fsSync.unlinkSync(alias);
      fsSync.symlinkSync(outside, alias, link);
      swapped = true;
    } })).rejects.toBeTruthy();
    expect(swapped).toBe(true);
    expect(await fs.readFile(path.join(directory, "actual/source"), "utf8")).toBe("inside");
    expect(await fs.readFile(path.join(outside, "source"), "utf8")).toBe("outside");
    await expect(fs.lstat(path.join(directory, "target"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("preserves invalid-rename errors instead of reporting missing native support", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-move-invalid-");
    await fs.mkdir(path.join(directory, "source"));
    const scoped = await root(directory);
    await expect(scoped.move("source", "source/child", { overwrite: true })).rejects.toMatchObject({ code: "EINVAL" });
    expect(await fs.readdir(directory)).toEqual(["source"]);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("renames without requiring directory-content read access", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-move-search-");
    await fs.writeFile(path.join(directory, "source"), "inside");
    const scoped = await root(directory);
    await fs.chmod(directory, 0o300);
    try { await scoped.move("source", "target", { overwrite: true }); }
    finally { await fs.chmod(directory, 0o700); }
    expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("inside");
  });
  it.each(["source", "target"] as const)("keeps both mutations inside the retained parents after a %s parent swap", async side => {
    const directory = await tempRoot("fs-safe-native-move-replace-");
    const outside = await tempRoot("fs-safe-native-move-outside-");
    await fs.mkdir(path.join(directory, "source"));
    await fs.mkdir(path.join(directory, "target"));
    await fs.writeFile(path.join(directory, "source/value"), "inside");
    await fs.writeFile(path.join(directory, "target/value"), "old");
    await fs.writeFile(path.join(outside, "value"), "outside");
    const scoped = await root(directory);
    let swapped = false;
    __setNativeLoaderForTest(() => ({ ...native!, renameReplaceWithIdentity(...args) {
      fsSync.renameSync(path.join(directory, side), path.join(directory, "held"));
      fsSync.symlinkSync(outside, path.join(directory, side), process.platform === "win32" ? "junction" : "dir");
      swapped = true;
      native!.renameReplaceWithIdentity!(...args);
    } }));
    configureFsSafeNative({ mode: "require" });
    await expect(scoped.move("source/value", "target/value", { overwrite: true })).rejects.toBeTruthy();
    expect(swapped).toBe(true);
    expect(await fs.readFile(path.join(outside, "value"), "utf8")).toBe("outside");
  });

  it("moves a directory over an empty directory", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-move-directory-");
    await fs.mkdir(path.join(directory, "source"));
    await fs.mkdir(path.join(directory, "target"));
    await fs.writeFile(path.join(directory, "source/value"), "inside");
    const scoped = await root(directory);
    const original = await fs.stat(path.join(directory, "source"), { bigint: true });
    let failure: unknown;
    try { await scoped.move("source", "target", { overwrite: true }); }
    catch (error) { failure = error; }
    if (failure) {
      expect(process.platform).toBe("win32");
      expect(["EACCES", "EPERM", "EEXIST", "ENOTEMPTY", "already-exists"]).toContain((failure as NodeJS.ErrnoException).code);
      expect(await fs.readFile(path.join(directory, "source/value"), "utf8")).toBe("inside");
      expect(await fs.readdir(path.join(directory, "target"))).toEqual([]);
    } else {
      expect(await fs.readFile(path.join(directory, "target/value"), "utf8")).toBe("inside");
      const moved = await fs.stat(path.join(directory, "target"), { bigint: true });
      expect({ dev: moved.dev, ino: moved.ino }).toEqual({ dev: original.dev, ino: original.ino });
      await expect(fs.lstat(path.join(directory, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

it("fails closed for overwrite when a required binding lacks the primitive", async () => {
  __setNativeLoaderForTest(() => ({ closeOwnedFd() {} }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("fs-safe-native-move-unavailable-");
  await fs.writeFile(path.join(directory, "source"), "source");
  await fs.writeFile(path.join(directory, "target"), "target");
  const scoped = await root(directory);
  const pending = scoped.move("source", "target", { overwrite: true });
  configureFsSafeNative({ mode: "auto" });
  await expect(pending).rejects.toMatchObject({ code: "helper-unavailable" });
  expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("target");
});
