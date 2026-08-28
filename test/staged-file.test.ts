import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageFileInDirectory } from "../src/advanced.js";
import { pinDirectory } from "../src/durability.js";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../src/native.js";
import { useTempDirs } from "./helpers/vitest.js";

let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = process.platform === "darwin" || process.platform === "linux";
} catch {
  // Real native cases run in the separate native CI lanes.
}
const { tempRoot } = useTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

for (const unavailable of ["off", "absent", "missing-capability", "windows"] as const) {
  it(`rejects ${unavailable} before creating any stage`, async () => {
    const directory = await tempRoot("fs-safe-stage-unavailable-");
    if (unavailable === "windows") {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    }
    if (unavailable === "off") {
      configureFsSafeNative({ mode: "off" });
    }
    if (unavailable === "absent") {
      __setNativeLoaderForTest(() => {
        throw new Error("no binding");
      });
    }
    if (unavailable === "missing-capability") {
      __setNativeLoaderForTest(() => ({} as never));
    }
    await expect(stageFileInDirectory({ directory, content: "x" })).rejects.toMatchObject({
      code: process.platform === "win32" ? "unsupported-platform" : "helper-unavailable",
    });
    expect(await fs.readdir(directory)).toEqual([]);
  });
}

describe.runIf(nativeAvailable)("retained-directory staging", () => {
  it.each(["", "snowman ☃", new Uint8Array([0, 255, 13, 10])])("prepares exact bytes %j without changing the parent", async (content) => {
    const directory = await tempRoot("fs-safe-stage-bytes-");
    await fs.chmod(directory, 0o750);
    const before = await fs.lstat(directory, { bigint: true });
    const staged = await stageFileInDirectory({ directory, content });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    try {
      expect(await fs.readFile(temporary)).toEqual(Buffer.from(content));
      const actual = await fs.lstat(temporary, { bigint: true });
      expect(staged.receipt.identity).toMatchObject({
        dev: actual.dev, ino: actual.ino, size: actual.size, mode: 0o600,
      });
      expect(actual.mode & 0o777n).toBe(0o600n);
      expect(staged.receipt.directory.identity).toEqual({ dev: before.dev, ino: before.ino });
      expect((await fs.lstat(directory)).mode & 0o777).toBe(0o750);
      await staged.assertCurrent();
    } finally {
      expect(await staged.cleanup()).toMatchObject({
        status: "removed", publication: { status: "not-published" }, resources: "closed",
      });
    }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["replacement", "rename-only", "ancestor"])("cleans the original after %s drift", async (kind) => {
    const base = await tempRoot("fs-safe-stage-drift-");
    const ancestor = path.join(base, "ancestor");
    const directory = path.join(ancestor, "parent");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "final"), "original final");
    const staged = await stageFileInDirectory({ directory, content: "unpublished" });
    const name = staged.receipt.temporaryBasename;
    const moved = path.join(base, "moved");
    await fs.rename(kind === "ancestor" ? ancestor : directory, moved);
    const original = kind === "ancestor" ? path.join(moved, "parent") : moved;
    const sentinels = new Map<string, Awaited<ReturnType<typeof fs.lstat>>>();
    if (kind !== "rename-only") {
      await fs.mkdir(directory, { recursive: true });
      for (const basename of [name, "final"]) {
        await fs.writeFile(path.join(directory, basename), `sentinel ${basename}`, { mode: 0o640 });
        sentinels.set(basename, await fs.lstat(path.join(directory, basename)));
      }
    }
    await expect(staged.assertCurrent()).rejects.toBeTruthy();
    await expect(staged.publish("final", { overwrite: true })).rejects.toMatchObject({
      details: { publication: { status: "not-published" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "removed" });
    expect(await fs.readdir(original)).toEqual(["final"]);
    expect(await fs.readFile(path.join(original, "final"), "utf8")).toBe("original final");
    for (const [basename, before] of sentinels) {
      expect(await fs.readFile(path.join(directory, basename), "utf8")).toBe(`sentinel ${basename}`);
      expect(await fs.lstat(path.join(directory, basename))).toMatchObject({
        dev: before.dev, ino: before.ino, mode: before.mode,
      });
    }
  });

  it.each(["regular", "symlink", "hardlink", "absent"])("preserves an observed %s substitution or reports name absence", async (kind) => {
    const directory = await tempRoot("fs-safe-stage-substitute-");
    const victim = path.join(directory, "victim");
    await fs.writeFile(victim, "victim");
    const before = await fs.lstat(victim, { bigint: true });
    const staged = await stageFileInDirectory({ directory, content: "owned" });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    await fs.rename(temporary, path.join(directory, "renamed-owned"));
    if (kind === "regular") {
      await fs.writeFile(temporary, "substitute");
    }
    if (kind === "symlink") {
      await fs.symlink(victim, temporary);
    }
    if (kind === "hardlink") {
      await fs.link(victim, temporary);
    }
    await expect(staged.publish("final", { overwrite: false })).rejects.toBeTruthy();
    const receipt = await staged.cleanup();
    expect(receipt.status).toBe(kind === "absent" ? "name-absent" : "preserved");
    expect(await fs.readFile(victim, "utf8")).toBe("victim");
    expect(await fs.lstat(victim, { bigint: true })).toMatchObject({
      dev: before.dev, ino: before.ino, mode: before.mode,
    });
    expect(await fs.readFile(path.join(directory, "renamed-owned"), "utf8")).toBe("owned");
    if (kind !== "absent") {
      expect(await fs.readFile(temporary, "utf8")).toBe(kind === "regular" ? "substitute" : "victim");
      await expect(staged[Symbol.asyncDispose]()).rejects.toMatchObject({
        details: { cleanup: { status: "preserved" } },
      });
    } else {
      await staged[Symbol.asyncDispose]();
    }
    expect(await staged.cleanup()).toEqual(receipt);
  });

  it.each([false, true])("publishes with explicit overwrite=%s and never cleans the final name", async (overwrite) => {
    const directory = await tempRoot("fs-safe-stage-publish-");
    const final = path.join(directory, "final");
    if (overwrite) {
      await fs.writeFile(final, "old");
    }
    const staged = await stageFileInDirectory({ directory, content: "new", mode: 0o640 });
    const publication = await staged.publish("final", { overwrite });
    expect(publication).toMatchObject({ status: "published", basename: "final", overwrite });
    expect(await fs.readFile(final, "utf8")).toBe("new");
    expect((await fs.stat(final)).mode & 0o777).toBe(0o640);
    expect(await staged.cleanup()).toMatchObject({ status: "not-needed", publication });
    await staged[Symbol.asyncDispose]();
    expect(await fs.readdir(directory)).toEqual(["final"]);
  });

  it("preserves no-replace collisions and permits a later publication", async () => {
    const directory = await tempRoot("fs-safe-stage-collision-");
    await fs.writeFile(path.join(directory, "final"), "old");
    const staged = await stageFileInDirectory({ directory, content: "new" });
    try {
      await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
        code: "already-exists", details: { publication: { status: "not-published" } },
      });
      expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("old");
      await staged.assertCurrent();
      await staged.publish("other", { overwrite: false });
      expect(await fs.readFile(path.join(directory, "other"), "utf8")).toBe("new");
    } finally {
      await staged[Symbol.asyncDispose]();
    }
  });

  it.each([
    { kind: "directory", code: "EISDIR" },
    { kind: "overlong basename", code: "ENAMETOOLONG" },
  ])("cleans its stage after $kind rejection", async ({ kind, code }) => {
    const directory = await tempRoot("fs-safe-stage-rejected-");
    const basename = kind === "directory" ? "target" : "x".repeat(256);
    if (kind === "directory") {
      await fs.mkdir(path.join(directory, basename));
      await fs.writeFile(path.join(directory, basename, "sentinel"), "unchanged");
    }
    const staged = await stageFileInDirectory({ directory, content: "unpublished" });
    try {
      await expect(staged.publish(basename, { overwrite: true })).rejects.toMatchObject({
        cause: { code }, details: { publication: { status: "not-published" } },
      });
      expect(await staged.cleanup()).toMatchObject({ status: "removed" });
      expect(await fs.readdir(directory)).toEqual(kind === "directory" ? [basename] : []);
      if (kind === "directory") {
        expect(await fs.readFile(path.join(directory, basename, "sentinel"), "utf8")).toBe("unchanged");
      }
    } finally {
      await staged.cleanup();
    }
  });

  it("verifies and publishes mode 000 without reopening the leaf", async () => {
    const directory = await tempRoot("fs-safe-stage-mode-");
    const staged = await stageFileInDirectory({ directory, content: "private", mode: 0 });
    try {
      expect((await fs.stat(path.join(directory, staged.receipt.temporaryBasename))).mode & 0o777).toBe(0o600);
      await staged.assertCurrent();
      await staged.publish("final", { overwrite: false });
      expect((await fs.stat(path.join(directory, "final"))).mode & 0o777).toBe(0);
    } finally {
      await staged[Symbol.asyncDispose]();
    }
  });

  it("rejects invalid publication names without consuming the stage", async () => {
    const directory = await tempRoot("fs-safe-stage-names-");
    const staged = await stageFileInDirectory({ directory, content: "kept" });
    try {
      for (const name of ["", ".", "..", "a/b", "a\\b", "/absolute", "a\0b", "C:relative", "bad\nname", staged.receipt.temporaryBasename]) {
        await expect(staged.publish(name, { overwrite: true })).rejects.toMatchObject({ code: "invalid-path" });
      }
      expect(await fs.readdir(directory)).toEqual([staged.receipt.temporaryBasename]);
      await staged.assertCurrent();
    } finally {
      await staged[Symbol.asyncDispose]();
    }
  });

  it("binds receipt admission and prevents receipt mutation from retargeting a live stage", async () => {
    const directory = await tempRoot("fs-safe-stage-receipt-");
    const pinned = await pinDirectory(directory);
    const supplied = pinned.receipt;
    const staged = await stageFileInDirectory({ directory: supplied, content: "owned" });
    const original = staged.receipt;
    const other = await tempRoot("fs-safe-stage-other-");
    supplied.path = other;
    supplied.realPath = other;
    supplied.identity.ino = 1;
    expect(Reflect.set(original.directory.identity, "ino", 1n)).toBe(false);
    expect(Reflect.set(original, "temporaryBasename", "victim")).toBe(false);
    await fs.writeFile(path.join(other, original.temporaryBasename), "victim");
    await staged.assertCurrent();
    expect(await staged.cleanup()).toMatchObject({ status: "removed" });
    expect(await fs.readFile(path.join(other, original.temporaryBasename), "utf8")).toBe("victim");
    await expect(stageFileInDirectory({ directory: supplied, content: "bad" })).rejects.toMatchObject({ code: "path-mismatch" });
    await pinned.close();
  });

  it.each(["publish-first", "cleanup-first"])("serializes %s and fences use after close", async (order) => {
    const directory = await tempRoot("fs-safe-stage-concurrent-");
    const staged = await stageFileInDirectory({ directory, content: "owned" });
    const actions = order === "publish-first"
      ? [staged.publish("final", { overwrite: false }), staged.assertCurrent(), staged.cleanup(), staged.cleanup()]
      : [staged.cleanup(), staged.publish("final", { overwrite: false }), staged.assertCurrent(), staged.cleanup()];
    const results = await Promise.allSettled(actions);
    expect(results[0]?.status).toBe("fulfilled");
    if (order === "cleanup-first") {
      expect(results.slice(1, 3).every((r) => r.status === "rejected")).toBe(true);
    }
    const unrelated = await fs.open(path.join(directory, "unrelated"), "w+");
    try {
      await unrelated.writeFile("untouched");
      await expect(staged.assertCurrent()).rejects.toMatchObject({ code: "helper-failed" });
      const publication = order === "publish-first"
        ? { status: "published", basename: "final" }
        : { status: "not-published" };
      await expect(staged.publish("unrelated", { overwrite: true })).rejects.toMatchObject({
        code: "helper-failed", cause: { code: "helper-failed" },
        details: { phase: "publish", publication },
      });
      await staged[Symbol.asyncDispose]();
      expect(await fs.readFile(path.join(directory, "unrelated"), "utf8")).toBe("untouched");
      expect(await fs.readdir(directory)).toEqual(order === "publish-first" ? ["final", "unrelated"] : ["unrelated"]);
    } finally {
      await unrelated.close();
    }
  });

  it("rejects an actual stale directory receipt and an ambiguous numeric identity before creation", async () => {
    const base = await tempRoot("fs-safe-stage-stale-");
    const directory = path.join(base, "parent");
    await fs.mkdir(directory);
    const pinned = await pinDirectory(directory);
    try {
      await fs.rename(directory, path.join(base, "moved"));
      await fs.mkdir(directory);
      await expect(stageFileInDirectory({ directory: pinned.receipt, content: "bad" })).rejects.toMatchObject({
        code: "path-mismatch",
      });
      const current = await pinDirectory(directory);
      try {
        current.receipt.identity.ino = Number.MAX_SAFE_INTEGER + 1;
        await expect(stageFileInDirectory({ directory: current.receipt, content: "bad" })).rejects.toMatchObject({
          code: "path-mismatch",
        });
      } finally {
        await current.close();
      }
      expect(await fs.readdir(directory)).toEqual([]);
      expect(await fs.readdir(path.join(base, "moved"))).toEqual([]);
    } finally {
      await pinned.close();
    }
  });
});
