import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync, writeTextAtomic } from "../src/atomic.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { writeJson } from "../src/json.js";
import { jsonStore } from "../src/json-store.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/private-temp-workspace.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { configureFsSafeNative, getFsSafeNativeConfig } from "../src/config.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { getNativeBinding } from "../src/native.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const nativeAvailable = Boolean(loadTestNative("required-env"));
const nativeModeAtStart = getFsSafeNativeConfig().mode;
beforeEach(() => { expect(getFsSafeNativeConfig().mode).toBe(nativeModeAtStart); });
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

const writers = ["text", "json", "sibling", "store", "store-sync", "stream", "copy", "prune"] as const;
itPosix.runIf(nativeAvailable)("keeps required-native store parent creation handle-relative", async () => {
  const rootDir = await tempRoot("fs-safe-preserve-native-parent-");
  await fs.chmod(rootDir, 0o2770);
  configureFsSafeNative({ mode: "require" });
  const pathnameMkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("pathname mkdir is forbidden"));
  const chmod = fsSync.fchmodSync.bind(fsSync);
  let directoryModes = 0;
  vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
    if (fsSync.fstatSync(fd).isDirectory()) directoryModes++;
    chmod(fd, mode);
  });
  const store = fileStore({ rootDir, dirMode: "preserve", durable: false });
  await store.write("one/two/state", "first");
  expect(directoryModes).toBe(2);
  await store.write("one/two/state", "second");
  expect(directoryModes).toBe(2);
  expect(pathnameMkdir).not.toHaveBeenCalled();
  expect((await fs.stat(rootDir)).mode & 0o7777).toBe(0o2770);
  expect((await fs.stat(path.join(rootDir, "one"))).mode & 0o7777).toBe(0o700);
  expect((await fs.stat(path.join(rootDir, "one/two"))).mode & 0o7777).toBe(0o700);
});

itPosix.each(writers)("%s keeps existing parents and creates new parents at 0700", async (writer) => {
  const dir = await tempRoot("fs-safe-preserve-api-");
  await fs.chmod(dir, 0o2770);
  const target = path.join(dir, "nested", "state");
  const policy = { dirMode: "preserve" as const, durable: false };
  const store = fileStore({ rootDir: dir, ...policy });
  if (writer === "text") await writeTextAtomic(target, "new", policy);
  else if (writer === "json") await writeJson(target, { value: "new" }, policy);
  else if (writer === "sibling") await writeSiblingTempFile({
    dir: path.dirname(target), dirMode: "preserve",
    writeTemp: async p => { await fs.writeFile(p, "new"); return target; }, resolveFinalPath: p => p,
  });
  else if (writer === "store") await store.write("nested/state", "new");
  else if (writer === "store-sync") fileStoreSync({ rootDir: dir, ...policy }).write("nested/state", "new");
  else if (writer === "stream") await store.writeStream("nested/state", Readable.from(["new"]));
  else if (writer === "copy") {
    const source = path.join(dir, "source");
    await fs.writeFile(source, "new");
    await store.copyIn("nested/state", source);
  } else await fileStore({ rootDir: path.dirname(target), ...policy }).pruneExpired({ ttlMs: 60_000 });
  expect((await fs.stat(dir)).mode & 0o7777).toBe(0o2770);
  expect((await fs.stat(path.dirname(target))).mode & 0o7777).toBe(0o700);
});

it.each(["secret-write", "secret-create", "private-store", "private-store-sync", "json-store"] as const)(
  "%s rejects preservation without weakening private mode policy", async (api) => {
    const rootDir = await tempRoot("fs-safe-private-preserve-");
    const filePath = path.join(rootDir, "state");
    const options = { rootDir, filePath, content: "secret", dirMode: "preserve" as const };
    await expect((async () => {
      if (api === "secret-write") await writeSecretFileAtomic(options);
      else if (api === "secret-create") await createSecretFileAtomic(options);
      else if (api === "private-store") await fileStore({ ...options, private: true }).write("state", "secret");
      else if (api === "private-store-sync") fileStoreSync({ ...options, private: true }).write("state", "secret");
      else await jsonStore({ ...options }).write({ secret: true });
    })()).rejects.toMatchObject({ code: "invalid-path" });
    expect(await fs.readdir(rootDir)).toEqual([]);
  },
);

itPosix.each(nativeAvailable ? ["off", "require"] as const : ["off"] as const)("temp workspace creation-default parity with native %s", async (mode) => {
  configureFsSafeNative({ mode });
  if (mode === "require") expect(getNativeBinding()).toBeDefined();
  const rootDir = await tempRoot("fs-safe-workspace-preserve-");
  const options = { rootDir, prefix: "workspace", dirMode: "preserve" as const };
  const workspace = await tempWorkspace(options);
  try { expect((await fs.stat(workspace.dir)).mode & 0o7777).toBe(0o700); }
  finally { await workspace.cleanup(); }
  const sync = tempWorkspaceSync(options);
  try { expect(fsSync.statSync(sync.dir).mode & 0o7777).toBe(0o700); }
  finally { sync.cleanup(); }
});

itPosix("a sync adapter needs fchmodSync only for numeric modes, file modes, or created directories", async () => {
  const dir = await tempRoot("fs-safe-preserve-adapter-");
  const { fchmodSync: _unused, ...fileSystem } = fsSync;
  replaceFileAtomicSync({ filePath: path.join(dir, "existing"), content: "new", dirMode: "preserve", fileSystem });
  expect(() => replaceFileAtomicSync({
    filePath: path.join(dir, "missing", "state"), content: "new", dirMode: "preserve", fileSystem,
  })).toThrow(/fchmodSync/);
  expect(await fs.readdir(dir)).toEqual(["existing"]);
});

it.each([false, true])("uses mkdir default handling on every platform (sync=%s)", async sync => {
  const dir = await tempRoot("fs-safe-preserve-platform-");
  const options = { filePath: path.join(dir, "nested", "state"), content: "new", dirMode: "preserve" as const };
  if (sync) replaceFileAtomicSync(options);
  else await replaceFileAtomic(options);
  expect(await fs.readFile(options.filePath, "utf8")).toBe("new");
});

itPosix.each([false, true])("store preservation rejects a symlink parent (sync=%s)", async sync => {
  const rootDir = await tempRoot("fs-safe-preserve-store-symlink-");
  const outside = await tempRoot("fs-safe-preserve-store-outside-");
  await fs.symlink(outside, path.join(rootDir, "link"));
  await expect((async () => {
    if (sync) fileStoreSync({ rootDir, dirMode: "preserve" }).write("link/state", "new");
    else await fileStore({ rootDir, dirMode: "preserve" }).write("link/state", "new");
  })()).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
});

itPosix.each([false, true])("snapshots numeric workspace dirMode once (sync=%s)", async sync => {
  const rootDir = await tempRoot("fs-safe-workspace-mode-snapshot-");
  let reads = 0;
  const options = { rootDir, prefix: "workspace", get dirMode() { reads++; return 0o700; } };
  const workspace = sync ? tempWorkspaceSync(options) : await tempWorkspace(options);
  try { expect(reads).toBe(1); }
  finally { await workspace.cleanup(); }
});

itPosix.each([false, true])("retains numeric dirMode reads for locked atomic writes (sync=%s)", async sync => {
  const dir = await tempRoot("fs-safe-atomic-mode-snapshot-");
  let reads = 0;
  const options = {
    filePath: path.join(dir, "state"), content: "new", renameIdentity: "verify-content-with-lock" as const,
    get dirMode() { reads++; return 0o700; },
  };
  if (sync) replaceFileAtomicSync(options);
  else await replaceFileAtomic(options);
  expect(reads).toBe(2);
});
