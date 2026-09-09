import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { fileStore, fileStoreSync, jsonStore, type FileStoreWriteOptions } from "../src/store.js";
import * as verification from "../src/root-write-verification.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
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
  configureFsSafeNative({ mode: "auto" });
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
  vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    record(this.fd);
    await asyncSync.call(this);
  });
  // The native pinned writer also synchronizes through this Node helper.
  vi.spyOn(fsSync, "fsyncSync").mockImplementation((fd) => {
    record(fd);
    syncSync(fd);
  });
  return events;
}

function expectSyncs(events: string[], durable: boolean, syncStore: boolean, backend: string, rootCopy = false) {
  if (!durable) {
    expect(events).toEqual([]);
  } else if (process.platform !== "win32") {
    expect(events).toEqual(["file", "parent"]);
  } else if (syncStore || rootCopy || (backend !== "off" && nativeAvailable)) {
    // Windows directory sync is not portable; JS async writes can also be unsynced.
    expect(events).toContain("file");
  }
}

const policies: {
  name: string;
  storeDefault?: boolean;
  options?: FileStoreWriteOptions;
  sync: boolean;
}[] = [
  { name: "default", sync: true },
  { name: "per-call false", options: { durable: false }, sync: false },
  { name: "store false", storeDefault: false, sync: false },
  { name: "undefined preserves store false", storeDefault: false, options: { durable: undefined }, sync: false },
  { name: "per-call true overrides store false", storeDefault: false, options: { durable: true }, sync: true },
  { name: "per-call false overrides store true", storeDefault: true, options: { durable: false }, sync: false },
];

for (const backend of ["auto", "require", "off"] as const) {
  describe.skipIf(backend === "require" && !nativeAvailable)(`store durable option: native ${backend}`, () => {
    for (const privateMode of [false, true]) {
      for (const method of ["writeStream", "copyIn"] as const) {
        it.each(policies)(`private=${privateMode} ${method}: $name`, async ({ storeDefault, options, sync }) => {
          configureFsSafeNative({ mode: backend });
          const directory = await tempRoot("fs-safe-store-copy-durable-");
          const source = path.join(directory, "source");
          const store = fileStore({ rootDir: directory, private: privateMode, durable: storeDefault });
          const target = path.join(directory, "nested/target");
          const events = await observeSyncs(directory);
          for (const value of ["first", "replacement"]) {
            await fs.writeFile(source, value);
            events.length = 0;
            const mode = value === "first" ? 0o640 : 0o600;
            const result = method === "copyIn"
              ? await store.copyIn("nested/target", source, { ...options, mode })
              : await store.writeStream("nested/target", Readable.from([value.slice(0, 2), value.slice(2)]), { ...options, mode });
            expect(result).toBe(target);
            expectSyncs(events, sync, false, backend, !privateMode);
            expect(await fs.readFile(target, "utf8")).toBe(value);
            if (process.platform !== "win32") {
              expect((await fs.stat(target)).mode & 0o777).toBe(mode);
              expect((await fs.stat(path.dirname(target))).mode & 0o777).toBe(0o700);
            }
            expect(await fs.readdir(path.dirname(target))).toEqual(["target"]);
          }
        });
      }
      for (const syncStore of [false, true]) {
        for (const method of ["write", "writeText", "writeJson"] as const) {
          it.each(policies)(`${syncStore ? "sync" : "async"} private=${privateMode} ${method}: $name`, async ({ storeDefault, options, sync }) => {
            configureFsSafeNative({ mode: backend });
            const directory = await tempRoot("fs-safe-store-durable-");
            const store = (syncStore ? fileStoreSync : fileStore)({
              rootDir: directory, private: privateMode, durable: storeDefault, mode: 0o640,
            });
            const target = path.join(directory, "nested/target");
            const events = await observeSyncs(directory);
            for (const value of ["first", "replacement"]) {
              events.length = 0;
              const mode = value === "first" ? 0o640 : 0o600;
              const writeOptions = value === "first" ? options : { ...options, mode };
              const result = method === "writeJson"
                ? await store.writeJson("nested/target", { value }, writeOptions)
                : await store[method]("nested/target", value, writeOptions);
              expect(result).toBe(target);
              expectSyncs(events, sync, syncStore, backend);
              expect(await fs.readFile(target, "utf8")).toBe(method === "writeJson"
                ? `${JSON.stringify({ value }, null, 2)}\n` : value);
              if (process.platform !== "win32") {
                expect((await fs.stat(target)).mode & 0o777).toBe(mode);
                expect((await fs.stat(path.dirname(target))).mode & 0o777).toBe(0o700);
              }
              expect(await fs.readdir(path.dirname(target))).toEqual(["target"]);
            }
          });
        }
        it(`rejects a substituted publication with durable=false, sync=${syncStore}, private=${privateMode}`, async () => {
          configureFsSafeNative({ mode: backend });
          const directory = await tempRoot("fs-safe-store-durable-fence-");
          const target = path.join(directory, "target");
          const published = path.join(directory, "published");
          const events = await observeSyncs(directory);
          if (syncStore) {
            const rename = fsSync.renameSync;
            vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
              rename(from, to);
              if (to !== target) return;
              rename(target, published);
              fsSync.writeFileSync(target, "substitute");
            });
            expect(() => fileStoreSync({ rootDir: directory, private: privateMode, durable: false })
              .write("target", "payload")).toThrow(expect.objectContaining({ code: "path-mismatch" }));
          } else {
            vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
              await fs.rename(target, published);
              await fs.writeFile(target, "substitute");
              await verifyPublished(params);
            });
            await expect(fileStore({ rootDir: directory, private: privateMode, durable: false })
              .write("target", "payload")).rejects.toMatchObject({ code: "path-mismatch" });
          }
          expect(events).toEqual([]);
          expect(await fs.readFile(target, "utf8")).toBe("substitute");
          expect(await fs.readFile(published, "utf8")).toBe("payload");
        });
      }
    }

    for (const method of ["write", "update", "updateOr"] as const) {
      it.each([undefined, false, true])(`jsonStore ${method}: durable=%s`, async (durable) => {
        configureFsSafeNative({ mode: backend });
        const directory = await tempRoot("fs-safe-json-durable-");
        const filePath = path.join(directory, "nested/state.json");
        const store = jsonStore<{ count: number }>({ filePath, durable });
        const events = await observeSyncs(directory);
        if (method === "write") await store.write({ count: 1 });
        else if (method === "update") await store.update((current) => ({ count: (current?.count ?? 0) + 1 }));
        else await store.updateOr({ count: 0 }, (current) => ({ count: current.count + 1 }));
        expectSyncs(events, durable !== false, false, backend);
        expect(await store.readRequired()).toEqual({ count: 1 });
        if (process.platform !== "win32") expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      });
    }

    it.each([
      { storeDefault: false, jsonDefault: undefined, sync: false },
      { storeDefault: false, jsonDefault: true, sync: true },
      { storeDefault: true, jsonDefault: false, sync: false },
    ])("bound JSON durable inheritance: %j", async ({ storeDefault, jsonDefault, sync }) => {
      configureFsSafeNative({ mode: backend });
      const directory = await tempRoot("fs-safe-bound-json-durable-");
      const store = fileStore({ rootDir: directory, durable: storeDefault })
        .json<{ count: number }>("state.json", { durable: jsonDefault });
      const events = await observeSyncs(directory);
      await store.updateOr({ count: 0 }, (current) => ({ count: current.count + 1 }));
      expectSyncs(events, sync, false, backend);
      expect(await store.readRequired()).toEqual({ count: 1 });
    });
  });
}
