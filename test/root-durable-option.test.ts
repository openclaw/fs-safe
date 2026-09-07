import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root, type RootWriteOptions } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import * as verification from "../src/root-write-verification.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const verifyPublished = verification.verifyAtomicWriteResult;
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

async function observeSyncs(directory: string) {
  const probePath = path.join(directory, "probe");
  const probe = await fs.open(probePath, "w");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  await fs.unlink(probePath);
  const events: string[] = [];
  const record = (fd: number) => events.push(fsSync.fstatSync(fd).isFile() ? "file" : "parent");
  const asyncSync = prototype.sync;
  const syncSync = fsSync.fsyncSync;
  const asyncSpy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    record(this.fd);
    await asyncSync.call(this);
  });
  // Native writers share this sync helper's fs.fsyncSync path.
  const syncSpy = vi.spyOn(fsSync, "fsyncSync").mockImplementation((fd) => {
    record(fd);
    syncSync(fd);
  });
  return { events, asyncSpy, syncSpy };
}

const policies: { name: string; rootDefault?: boolean; options?: RootWriteOptions; sync: boolean }[] = [
  { name: "default", sync: true },
  { name: "per-call false", options: { durable: false }, sync: false },
  { name: "root false", rootDefault: false, sync: false },
  { name: "undefined preserves root false", rootDefault: false, options: { durable: undefined }, sync: false },
  { name: "per-call true overrides root false", rootDefault: false, options: { durable: true }, sync: true },
  { name: "per-call false overrides root true", rootDefault: true, options: { durable: false }, sync: false },
];

for (const backend of ["auto", "off"] as const) {
  describe.skipIf(backend === "auto" && !nativeAvailable)(`Root durable option: native ${backend}`, () => {
    for (const method of ["write", "create", "writeJson", "createJson", "append"] as const) {
      // The Windows JavaScript fallback cannot rename over a read-only destination.
      const modes = process.platform === "win32" && backend === "off" && method !== "append" ? [0o640] : [0o640, 0o400];
      it.each(policies.flatMap((policy) => modes.map((mode) => ({ ...policy, mode }))))(
        `${method}: $name, mode $mode`,
        async ({ rootDefault, options, sync, mode }) => {
          configureFsSafeNative({ mode: backend });
          const directory = await tempRoot("fs-safe-durable-");
          const safe = await root(directory, { durable: rootDefault });
          expect(safe.defaults.durable).toBe(rootDefault);
          const { events, asyncSpy, syncSpy } = await observeSyncs(directory);
          const isJson = method === "writeJson" || method === "createJson";
          if (isJson) {
            await safe[method]("target", { value: "payload" }, { ...options, mode });
          } else {
            await safe[method]("target", "payload", { ...options, mode });
          }
          if (!sync || (process.platform === "win32" && backend === "off" && method !== "append")) {
            expect(asyncSpy).not.toHaveBeenCalled();
            expect(syncSpy).not.toHaveBeenCalled();
          } else if (process.platform === "win32") {
            // Windows directory sync may be unavailable; the file sync is observable.
            expect(events).toContain("file");
          } else {
            expect(events).toEqual(backend === "auto" && method !== "append" && mode === 0o400
              ? ["file", "file", "parent"] : ["file", "parent"]);
            expect(backend === "auto" && method !== "append" ? syncSpy : asyncSpy).toHaveBeenCalled();
          }
          const target = path.join(directory, "target");
          if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(mode);
          await fs.chmod(target, 0o600);
          expect(await fs.readFile(target, "utf8")).toBe(isJson ? '{"value":"payload"}\n' : "payload");
          expect(await fs.readdir(directory)).toEqual(["target"]);
        },
      );
    }

    it.each([true, false])("replaces an existing inode and preserves its mode with durable %s", async (durable) => {
      configureFsSafeNative({ mode: backend });
      const directory = await tempRoot("fs-safe-durable-replace-");
      const target = path.join(directory, "target");
      await fs.writeFile(target, "old bytes", { mode: 0o640 });
      const before = await fs.stat(target);
      const safe = await root(directory);
      const { events } = await observeSyncs(directory);
      await safe.write("target", "new bytes", { durable });
      expect(await fs.readFile(target, "utf8")).toBe("new bytes");
      const after = await fs.stat(target);
      expect(after.ino).not.toBe(before.ino);
      expect(after.mode).toBe(before.mode);
      if (!durable) expect(events).toEqual([]);
    });

    it.each([true, false])("appends in place with durable %s and no parent sync", async (durable) => {
      configureFsSafeNative({ mode: backend });
      const directory = await tempRoot("fs-safe-durable-append-");
      const target = path.join(directory, "target");
      await fs.writeFile(target, "old", { mode: 0o600 });
      const before = await fs.stat(target);
      const safe = await root(directory);
      const { events } = await observeSyncs(directory);
      await safe.append("target", Buffer.from("new"), { durable, prependNewlineIfNeeded: true });
      expect(events).toEqual(durable ? ["file"] : []);
      expect(await fs.readFile(target, "utf8")).toBe("old\nnew");
      expect((await fs.stat(target)).ino).toBe(before.ino);
    });

    it.each(["write", "create"] as const)("%s retains post-publication identity rejection without sync", async (method) => {
      configureFsSafeNative({ mode: backend });
      const directory = await tempRoot("fs-safe-durable-fence-");
      const target = path.join(directory, "target");
      const safe = await root(directory, { durable: false });
      vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
        await fs.rename(target, path.join(directory, "published"));
        await fs.writeFile(target, "substitute");
        await verifyPublished(params);
      });
      const { events } = await observeSyncs(directory);
      await expect(safe[method]("target", "payload")).rejects.toMatchObject({ code: "path-mismatch" });
      expect(events).toEqual([]);
      expect(await fs.readFile(target, "utf8")).toBe("substitute");
      expect(await fs.readFile(path.join(directory, "published"), "utf8")).toBe("payload");
    });

    it("retains create-only errors and copyIn durability with a false root default", async () => {
      configureFsSafeNative({ mode: backend });
      const directory = await tempRoot("fs-safe-durable-copy-");
      const source = path.join(directory, "source");
      await fs.writeFile(source, "payload");
      const safe = await root(directory, { durable: false });
      await expect(safe.create("source", "replacement")).rejects.toMatchObject({ code: "already-exists" });
      await expect(safe.write("../escape", "payload")).rejects.toMatchObject({ code: "outside-workspace" });
      const { events } = await observeSyncs(directory);
      await safe.copyIn("target", source);
      expect(events).toContain("file");
      expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("payload");
    });
  });
}

describe.skipIf(process.platform === "win32")("Windows writer branch simulation", () => {
  it.each([true, false])("preserves the unsynced JS writer with durable %s", async (durable) => {
    configureFsSafeNative({ mode: "off" });
    Object.defineProperty(process, "platform", { value: "win32" });
    const directory = await tempRoot("fs-safe-durable-win-js-");
    const safe = await root(directory, { durable });
    const { events } = await observeSyncs(directory);
    await safe.create("created", "created");
    await safe.write("created", "replaced");
    expect(events).toEqual([]);
    expect(await fs.readFile(path.join(directory, "created"), "utf8")).toBe("replaced");
  });

  it.skipIf(!nativeAvailable).each([true, false])("gates every Windows native sync with sync %s", async (sync) => {
    const binding = __loadBundledNativeForTest();
    __setNativeLoaderForTest(() => binding);
    configureFsSafeNative({ mode: "auto" });
    Object.defineProperty(process, "platform", { value: "win32" });
    const directory = await tempRoot("fs-safe-durable-win-native-");
    const { events } = await observeSyncs(directory);
    await runPinnedWriteHelper({
      rootPath: directory, relativeParentPath: "", basename: "target", mkdir: false,
      mode: 0o400, sync, input: { kind: "buffer", data: "payload" },
    });
    expect(events).toEqual(sync ? ["file", "file", "parent"] : []);
    expect((await fs.stat(path.join(directory, "target"))).mode & 0o777).toBe(0o400);
    expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("payload");
  });
});
