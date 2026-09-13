import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
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
  it.for(
    [
      { label: "automatic cloning by default", clone: undefined },
      { label: "cloning disabled", clone: "never" as const },
    ].flatMap((policy) => [1, 4, 32].map((concurrency) => ({ ...policy, concurrency }))),
  )(
    "copies without a native binding with $label and $concurrency workers",
    async ({ clone, concurrency }) => {
      const { source, destination } = await copyFixture();
      const original = path.join(source, "payload");
      const copied = path.join(destination, "payload");
      await fs.utimes(original, 1_600_000_000, 1_600_000_000);
      if (process.platform !== "win32") await fs.chmod(original, 0o751);
      await fs.mkdir(path.join(source, "nested", "deep"), { recursive: true });
      const contents = new Map<string, Buffer>();
      for (let index = 0; index < 12; index++) {
        const parent = ["", "nested", path.join("nested", "deep")][index % 3]!;
        const name = path.join(parent, `file-${index}`);
        const bytes = Buffer.alloc(1024 * 1024 + 17 + index, index + 1);
        bytes.fill(index + 77, 1024 * 1024);
        contents.set(name, bytes);
        await fs.writeFile(path.join(source, name), bytes);
        await fs.utimes(path.join(source, name), 1_600_000_000 + index, 1_600_000_000 + index);
      }
      const directories = ["", "empty", "nested", path.join("nested", "deep")];
      for (const name of directories) {
        await fs.utimes(path.join(source, name), 1_500_000_000, 1_500_000_000);
      }

      await copyTree(source, destination, { clone, concurrency });
      for (const [name, bytes] of contents) {
        expect((await fs.readFile(path.join(destination, name))).equals(bytes), name).toBe(true);
        expect((await fs.stat(path.join(destination, name))).mtimeMs, name).toBe(
          (await fs.stat(path.join(source, name))).mtimeMs,
        );
      }
      for (const name of directories) {
        expect((await fs.stat(path.join(destination, name))).mtimeMs, name).toBe(1_500_000_000_000);
      }
      expect(await fs.readFile(copied, "utf8")).toBe("original");
      expect(await fs.readdir(path.join(destination, "empty"))).toEqual([]);
      expect((await fs.stat(copied)).mtimeMs).toBe(1_600_000_000_000);
      if (process.platform !== "win32") expect((await fs.stat(copied)).mode & 0o777).toBe(0o751);
      await fs.writeFile(copied, "independent edit");
      expect(await fs.readFile(original, "utf8")).toBe("original");
      const [parallelFile, parallelBytes] = contents.entries().next().value!;
      await fs.writeFile(path.join(destination, parallelFile), "independent parallel edit");
      expect((await fs.readFile(path.join(source, parallelFile))).equals(parallelBytes)).toBe(true);
    },
  );

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

  it("does not load native copy or clone helpers when cloning is disabled", async () => {
    configureFsSafeNative({ mode: "auto" });
    const { source, destination } = await copyFixture();
    let nativeLoads = 0;
    __setNativeLoaderForTest(() => {
      nativeLoads++;
      throw new Error("native helpers must not load");
    });
    await copyTree(source, destination, { clone: "never" });
    expect(nativeLoads).toBe(0);
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
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const open = fs.open.bind(fs);
    let writes = 0;
    let copiedFd: number | undefined;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === copied && args[1] === "wx") {
        copiedFd = handle.fd;
        const write = handle.write.bind(handle);
        // This fixture exercises the buffer overload and forwards the real write.
        vi.spyOn(handle, "write").mockImplementation((async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          const result = await write(buffer, offset, length, position);
          writes++;
          written.resolve();
          await release.promise;
          return result;
        }) as FileHandle["write"]);
      }
      return handle;
    });
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
    try {
      await Promise.race([
        written.promise,
        pending.then((error) => {
          throw error ?? new Error("copy completed before the held write");
        }),
      ]);
      const partial = await fs.stat(copied);
      expect(partial.size).toBeGreaterThan(0);
      expect(partial.size).toBeLessThan(bytes.length / 2);
      controller.abort(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(fsSync.fstatSync(copiedFd!).isFile()).toBe(true);
      release.resolve();
      expect(await pending).toBe(reason);
      expect((await fs.stat(copied)).size).toBeLessThan(bytes.length);
      const afterAbort = await fs.readFile(copied);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toBe(1);
      expect((await fs.readFile(copied)).equals(afterAbort)).toBe(true);
      openSpy.mockRestore();
      await fs.rm(destination, { recursive: true });
      await copyTree(source, destination, { clone: "never" });
      expect((await fs.readFile(copied)).equals(bytes)).toBe(true);
      expect((await fs.readFile(original)).equals(bytes)).toBe(true);
    } finally {
      controller.abort(reason);
      release.resolve();
      await pending;
      openSpy.mockRestore();
    }
  });

  it("rejects an invalid clone policy before creating a destination", async () => {
    const { source, destination } = await copyFixture();
    // @ts-expect-error JavaScript callers can supply an invalid policy.
    await expect(copyTree(source, destination, { clone: "sometimes" })).rejects.toThrow();
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32").each(["abort", "file error"] as const)(
    "joins admitted native file writes after %s without exceeding concurrency",
    async (stop, context) => {
      configureFsSafeNative({ mode: "auto" });
      const binding = getNativeBinding();
      if (!binding) {
        context.skip("native binding unavailable");
        return;
      }
      const { source, destination } = await copyFixture();
      for (let index = 0; index < 4; index++) {
        await fs.writeFile(path.join(source, `file-${index}`), `distinct contents ${index}`);
      }
      const entered = Promise.withResolvers<void>();
      const fail = Promise.withResolvers<void>();
      const failed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const reason = Object.assign(new Error(`copy stopped by ${stop}`), { code: "EIO" });
      const calls: { sourceFd: number; targetFd: number; signal?: AbortSignal }[] = [];
      let active = 0;
      let peakActive = 0;
      let writes = 0;
      __setNativeLoaderForTest(() => ({
        ...binding,
        probeTreeClone: () => null,
        async copyFileContents(sourceFd, targetFd, signal) {
          const index = calls.push({ sourceFd, targetFd, signal }) - 1;
          active++;
          peakActive = Math.max(peakActive, active);
          if (calls.length === 2) entered.resolve();
          try {
            if (index === 1) {
              await fail.promise;
              failed.resolve();
              throw reason;
            }
            await release.promise;
            expect(fsSync.fstatSync(sourceFd).isFile()).toBe(true);
            expect(fsSync.fstatSync(targetFd).isFile()).toBe(true);
            fsSync.writeFileSync(targetFd, fsSync.readFileSync(sourceFd));
            writes++;
          } finally {
            active--;
          }
        },
      }));
      let settled = false;
      const pending = copyTree(source, destination, {
        concurrency: 2,
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
      try {
        await Promise.race([
          entered.promise,
          pending.then((error) => {
            throw error ?? new Error("copy settled before two admissions");
          }),
        ]);
        expect(calls[0]!.signal).not.toBe(controller.signal);
        expect(calls[0]!.signal).not.toBe(calls[1]!.signal);
        if (stop === "abort") controller.abort(reason);
        fail.resolve();
        await failed.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(active).toBe(1);
        expect(calls).toHaveLength(2);
        expect(peakActive).toBe(2);
        expect(calls[0]!.signal?.aborted).toBe(true);
        release.resolve();
        expect(await pending).toBe(reason);
        expect(active).toBe(0);
        expect(writes).toBe(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(calls).toHaveLength(2);
        expect(writes).toBe(1);
        __resetNativeLoaderForTest();
        await fs.rm(destination, { recursive: true });
        await copyTree(source, destination, { clone: "never", concurrency: 2 });
        for (const name of await fs.readdir(source)) {
          if (name === "empty") continue;
          expect(await fs.readFile(path.join(destination, name))).toEqual(
            await fs.readFile(path.join(source, name)),
          );
        }
      } finally {
        controller.abort(reason);
        fail.resolve();
        release.resolve();
        await pending;
      }
    },
  );
});
