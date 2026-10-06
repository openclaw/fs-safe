import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root, FsSafeError, isNoReplaceUnsupported } from "../src/index.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { NATIVE_NOREPLACE_UNSUPPORTED } from "../src/native-noreplace.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const native = loadTestNative("required-env");
const { tempRoot } = useRealTempDirs();
const unsupported = () => Object.assign(new Error("renameat2 RENAME_NOREPLACE: EINVAL"), { code: NATIVE_NOREPLACE_UNSUPPORTED });
afterEach(() => { configureFsSafeNative({ mode: "auto" }); __resetNativeLoaderForTest(); });

it("classifies only the documented no-replace capability", () => {
  expect(isNoReplaceUnsupported(new FsSafeError("helper-unavailable", "loader missing"))).toBe(false);
  expect(isNoReplaceUnsupported(unsupported())).toBe(false);
  expect(isNoReplaceUnsupported(new FsSafeError("helper-unavailable", "rename refused", {
    details: { capability: "rename-noreplace" },
  }))).toBe(true);
});

describe.skipIf(process.platform !== "linux" || !native)("Root no-replace move fallback", () => {
  it.each(["file", "directory"])("moves a %s in auto and caches only sibling rejection", async kind => {
    const directory = await tempRoot("fs-safe-auto-move-");
    const rename = vi.fn(() => { throw unsupported(); });
    const fallback = vi.fn(native!.moveNoReplaceFallback!);
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: rename, moveNoReplaceFallback: fallback }));
    const scoped = await root(directory);
    for (let i = 0; i < 2; i++) {
      const source = path.join(directory, `source${i}`);
      if (kind === "file") await fs.writeFile(source, "source");
      else { await fs.mkdir(source); await fs.writeFile(path.join(source, "child"), "source"); }
      const before = await fs.lstat(source, { bigint: true });
      await scoped.move(`source${i}`, `target${i}`);
      expect(await fs.lstat(path.join(directory, `target${i}`), { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(rename).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it.each(["file", "directory"])("keeps require strict for a %s", async kind => {
    configureFsSafeNative({ mode: "require" });
    const fallback = vi.fn(native!.moveNoReplaceFallback!);
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace() { throw unsupported(); }, moveNoReplaceFallback: fallback }));
    const directory = await tempRoot("fs-safe-require-move-");
    if (kind === "file") await fs.writeFile(path.join(directory, "source"), "source");
    else await fs.mkdir(path.join(directory, "source"));
    await expect((await root(directory)).move("source", "target")).rejects.toSatisfy(isNoReplaceUnsupported);
    expect(fallback).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual(["source"]);
  });

  it.each(["file", "directory", "symlink"])("preserves a competing %s before fallback", async kind => {
    const directory = await tempRoot("fs-safe-move-collision-");
    const target = path.join(directory, "target");
    await fs.writeFile(path.join(directory, "source"), "source");
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace() {
      if (kind === "file") fsSync.writeFileSync(target, "competitor");
      else if (kind === "directory") fsSync.mkdirSync(target);
      else fsSync.symlinkSync("source", target);
      throw unsupported();
    } }));
    await expect((await root(directory)).move("source", "target")).rejects.toMatchObject({ code: "already-exists" });
    expect(await fs.readFile(path.join(directory, "source"), "utf8")).toBe("source");
    if (kind === "file") expect(await fs.readFile(target, "utf8")).toBe("competitor");
    if (kind === "symlink") expect(await fs.readlink(target)).toBe("source");
  });

  it("refuses a source replaced after rename rejection", async () => {
    const directory = await tempRoot("fs-safe-move-source-");
    const source = path.join(directory, "source");
    await fs.writeFile(source, "source");
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace() {
      fsSync.renameSync(source, path.join(directory, "saved"));
      fsSync.writeFileSync(source, "replacement");
      throw unsupported();
    } }));
    await expect((await root(directory)).move("source", "target")).rejects.toMatchObject({ code: "path-mismatch" });
    expect(await fs.readFile(source, "utf8")).toBe("replacement");
    expect(await fs.readdir(directory)).toEqual(["saved", "source"]);
  });
});
