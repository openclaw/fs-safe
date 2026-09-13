import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { copyTree } from "../src/copy.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  getNativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

async function copyFixture() {
  const directory = await tempRoot("fs-safe-copy-tree-");
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination-é space");
  await fs.mkdir(source);
  await fs.mkdir(path.join(source, "empty"));
  await fs.writeFile(path.join(source, "payload"), "original");
  return { directory, source, destination };
}

describe("directory copying", () => {
  it.for([
    { label: "automatic cloning by default", clone: undefined },
    { label: "cloning disabled", clone: "never" as const },
  ])("copies without a native binding with $label", async ({ clone }) => {
    const { source, destination } = await copyFixture();
    const original = path.join(source, "payload");
    const copied = path.join(destination, "payload");
    await fs.utimes(original, 1_600_000_000, 1_600_000_000);
    if (process.platform !== "win32") await fs.chmod(original, 0o751);

    await copyTree(source, destination, { clone });
    expect(await fs.readFile(copied, "utf8")).toBe("original");
    expect(await fs.readdir(path.join(destination, "empty"))).toEqual([]);
    expect((await fs.stat(copied)).mtimeMs).toBe(1_600_000_000_000);
    if (process.platform !== "win32") expect((await fs.stat(copied)).mode & 0o777).toBe(0o751);
    await fs.writeFile(copied, "independent edit");
    expect(await fs.readFile(original, "utf8")).toBe("original");
  });

  it("requires native cloning when the policy is always", async () => {
    const { source, destination } = await copyFixture();
    await expect(copyTree(source, destination, { clone: "always" })).rejects.toThrow();
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("original");
  });

  it.for([
    { code: "CLONE_UNAVAILABLE", fallback: true },
    { code: "EXDEV", fallback: true },
    { code: "ENOSYS", fallback: true },
    { code: "ENOTSUP", fallback: false },
    { code: "EACCES", fallback: false },
    { code: "EIO", fallback: false },
  ])(
    "handles native $code without confusing capability failures with source errors",
    async ({ code, fallback }, context) => {
      configureFsSafeNative({ mode: "auto" });
      const binding = getNativeBinding();
      if (!binding) {
        context.skip("native binding unavailable");
        return;
      }
      const { source, destination } = await copyFixture();
      const failure = Object.assign(new Error(`native copy failed: ${code}`), { code });
      __setNativeLoaderForTest(() => ({
        ...binding,
        probeTreeClone: () => "xfs",
        async cloneTree() {
          throw failure;
        },
      }));
      if (fallback) {
        await copyTree(source, destination);
        expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe("original");
      } else {
        await expect(copyTree(source, destination)).rejects.toBe(failure);
        await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("original");
    },
  );

  it("never invokes the native clone operation when cloning is disabled", async (context) => {
    configureFsSafeNative({ mode: "auto" });
    const binding = getNativeBinding();
    if (!binding) {
      context.skip("native binding unavailable");
      return;
    }
    const { source, destination } = await copyFixture();
    let nativeCalls = 0;
    __setNativeLoaderForTest(() => ({
      ...binding,
      probeTreeClone: () => "xfs",
      async cloneTree() {
        nativeCalls++;
        throw new Error("native cloning must not run");
      },
    }));
    await copyTree(source, destination, { clone: "never" });
    expect(nativeCalls).toBe(0);
    expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe("original");
  });

  it("refuses an existing destination without merging or replacing its contents", async () => {
    const { source, destination } = await copyFixture();
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, "payload"), "keep this destination");
    await expect(copyTree(source, destination)).rejects.toThrow();
    expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe(
      "keep this destination",
    );
    expect(await fs.readdir(destination)).toEqual(["payload"]);
  });

  it("preserves relative file and directory symlinks before their copied targets exist", async (context) => {
    const { source, destination } = await copyFixture();
    await fs.mkdir(path.join(source, "z-directory"));
    await fs.writeFile(path.join(source, "z-directory", "child"), "directory contents");
    try {
      await fs.symlink("payload", path.join(source, "link"), "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        context.skip("Windows symlink creation requires Developer Mode or privilege");
      }
      throw error;
    }
    await fs.symlink("z-directory", path.join(source, "a-directory-link"), "dir");
    await copyTree(source, destination);
    expect(await fs.readlink(path.join(destination, "link"))).toBe("payload");
    expect(await fs.readlink(path.join(destination, "a-directory-link"))).toBe("z-directory");
    expect(await fs.readdir(path.join(destination, "a-directory-link"))).toEqual(["child"]);
    expect(await fs.readFile(path.join(destination, "a-directory-link", "child"), "utf8")).toBe(
      "directory contents",
    );
    await fs.writeFile(path.join(destination, "payload"), "copy edit");
    expect(await fs.readFile(path.join(destination, "link"), "utf8")).toBe("copy edit");
    expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("original");
  });

  it.skipIf(process.platform === "win32")(
    "preserves dangling POSIX symlinks literally",
    async () => {
      const { source, destination } = await copyFixture();
      await fs.symlink("missing-target", path.join(source, "dangling"));
      const rawTarget = Buffer.from([0xff]);
      await fs.symlink(rawTarget, path.join(source, "raw-link"));
      await copyTree(source, destination);
      const copied = path.join(destination, "dangling");
      expect(await fs.readlink(copied)).toBe("missing-target");
      expect((await fs.lstat(copied)).isSymbolicLink()).toBe(true);
      await expect(fs.stat(copied)).rejects.toMatchObject({ code: "ENOENT" });
      for (const directory of [source, destination]) {
        expect(await fs.readlink(path.join(directory, "raw-link"), { encoding: "buffer" })).toEqual(
          rawTarget,
        );
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects an unresolved Windows link instead of guessing its type",
    async () => {
      const { source, destination } = await copyFixture();
      const missing = path.join(source, "missing-target");
      const dangling = path.join(source, "dangling");
      await fs.symlink(missing, dangling, "junction");
      await expect(copyTree(source, destination)).rejects.toMatchObject({
        code: "unsupported-platform",
      });
      expect(await fs.readlink(dangling)).toBe(missing);
      await expect(fs.lstat(path.join(destination, "dangling"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("honors pre-abort without creating a destination", async () => {
    const { source, destination } = await copyFixture();
    const reason = new Error("copy canceled by caller");
    await expect(copyTree(source, destination, { signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles a byte copy aborted after visible progress before the destination is reused", async () => {
    const { source, destination } = await copyFixture();
    const original = path.join(source, "payload");
    const copied = path.join(destination, "payload");
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    await fs.writeFile(original, bytes);
    const controller = new AbortController();
    const reason = new Error("cancel after partial byte copy");
    let settled = false;
    const pending = copyTree(source, destination, {
      clone: "never",
      signal: controller.signal,
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    let observedPartialWrite = false;
    const deadline = performance.now() + 2000;
    try {
      while (!settled && performance.now() < deadline) {
        const stat = await fs.stat(copied).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
          throw error;
        });
        if (stat && stat.size > 0 && stat.size < bytes.length / 2) {
          observedPartialWrite = true;
          controller.abort(reason);
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(observedPartialWrite).toBe(true);
      expect(await pending).toBe(reason);
      expect((await fs.stat(copied)).size).toBeLessThan(bytes.length);
      await fs.rm(destination, { recursive: true });
      await copyTree(source, destination, { clone: "never" });
      expect((await fs.readFile(copied)).equals(bytes)).toBe(true);
      expect((await fs.readFile(original)).equals(bytes)).toBe(true);
    } finally {
      controller.abort(reason);
      await pending;
    }
  });

  it("rejects an invalid clone policy before creating a destination", async () => {
    const { source, destination } = await copyFixture();
    // @ts-expect-error JavaScript callers can supply an invalid policy.
    await expect(copyTree(source, destination, { clone: "sometimes" })).rejects.toThrow();
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
