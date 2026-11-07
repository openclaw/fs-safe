import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync, writeTextAtomic } from "../src/atomic.js";
import { writeJson, writeJsonSync } from "../src/json.js";
import { jsonStore } from "../src/json-store.js";
import { writeExternalFileWithinRoot } from "../src/output.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { root } from "../src/root.js";
import { stageFileInDirectory } from "../src/advanced.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { hideRenamedFileWhileOpen } from "./helpers/rename-hidden.js";
import { useRealTempDirs } from "./helpers/vitest.js";
const { tempRoot } = useRealTempDirs();
const mount = { magic: 0x01021997n, fdinfo: "mnt_id:\t51\n", mountinfo: "51 1 0:69 / /mnt/c rw - 9p C: rw,aname=drvfs;metadata" };
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); __resetNativeLoaderForTest(); __setFsSafeTestHooksForTest(undefined); });
const writers = {
  async: (p: string, option: boolean) => replaceFileAtomic({ filePath: p, content: "payload", allowDrvfsRenameRecovery: option }),
  sync: (p: string, option: boolean) => replaceFileAtomicSync({ filePath: p, content: "payload", allowDrvfsRenameRecovery: option }),
  text: (p: string, option: boolean) => writeTextAtomic(p, "payload", { allowDrvfsRenameRecovery: option }),
  json: (p: string, option: boolean) => writeJson(p, { value: "payload" }, { allowDrvfsRenameRecovery: option }),
  jsonSync: (p: string, option: boolean) => writeJsonSync(p, { value: "payload" }, { allowDrvfsRenameRecovery: option }),
  store: (p: string, option: boolean) => fileStore({ rootDir: path.dirname(p), allowDrvfsRenameRecovery: option }).write("target", "payload"),
  storeSync: (p: string, option: boolean) => fileStoreSync({ rootDir: path.dirname(p), allowDrvfsRenameRecovery: option }).write("target", "payload"),
  jsonStore: (p: string, option: boolean) => jsonStore({ filePath: p, allowDrvfsRenameRecovery: option }).write({ value: "payload" }),
  storeJson: (p: string, option: boolean) => fileStore({ rootDir: path.dirname(p) }).json("target", { allowDrvfsRenameRecovery: option }).write({ value: "payload" }),
  output: (p: string, option: boolean) => writeExternalFileWithinRoot({ rootDir: path.dirname(p), path: "target", staging: "sibling", allowDrvfsRenameRecovery: option, write: name => fsp.writeFile(name, "payload") }),
  siblingReadonly: (p: string, option: boolean) => writeSiblingTempFile({ dir: path.dirname(p), writeTemp: name => fsp.writeFile(name, "payload"), resolveFinalPath: () => p, mode: 0o400, syncTempFile: true, allowDrvfsRenameRecovery: option }),
  sibling: (p: string, option: boolean) => writeSiblingTempFile({ dir: path.dirname(p), writeTemp: name => fsp.writeFile(name, "payload"), resolveFinalPath: () => p, allowDrvfsRenameRecovery: option }),
  root: async (p: string, option: boolean) => (await root(path.dirname(p), { allowDrvfsRenameRecovery: option })).write("target", "payload"),
};
describe.skipIf(process.platform === "win32").each(Object.entries(writers))("%s publication", (_, write) => {
  it.each([true, false])("requires explicit option=%s", async option => {
    configureFsSafeNative({ mode: "off" });
    const filePath = path.join(await tempRoot("rename-hidden-"), "target");
    const fault = hideRenamedFileWhileOpen(filePath);
    __setFsSafeTestHooksForTest({ drvfsMountObservation: () => mount });
    const operation = Promise.resolve().then(() => write(filePath, option));
    if (option) await operation; else await expect(operation).rejects.toBeTruthy();
    expect(fault.failures).toBeGreaterThan(0);
    if (!option) expect(fault.failures).toBe(1);
    expect(fault.hidden).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toContain("payload");
  });
});
let native: ReturnType<typeof __loadBundledNativeForTest> | undefined;
try { if (process.platform === "linux" || process.platform === "darwin") native = __loadBundledNativeForTest(); } catch { /* required in native CI */ }
describe.runIf(native)("native publication", () => {
  it.each(["root", "stage"].flatMap(api => ["success", "off", "swap", "delete", "owner", "reused", "restrictive"].map(kind => ({ api, kind }))))("$api: $kind", async ({ api, kind }) => {
    const directory = await tempRoot("native-rename-hidden-");
    const filePath = path.join(directory, "target");
    const originalFstat = fs.fstatSync;
    const originalLstat = fs.lstatSync;
    const fault = hideRenamedFileWhileOpen(filePath, () => {
      if (kind === "swap" || kind === "delete" || kind === "reused") {
        fs.unlinkSync(filePath);
        if (kind !== "delete") fs.writeFileSync(filePath, "foreign", { mode: 0o600 });
      }
      if (kind === "restrictive") expect(originalLstat(filePath).mode & 0o777).toBe(0o400);
    });
    const forge = (stat: fs.BigIntStats | fs.Stats) => {
      if (fault.closes && stat.isFile()) {
        if (kind === "owner") Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1 });
        if (kind === "reused") for (const key of ["dev", "ino"] as const) Object.defineProperty(stat, key, { value: typeof stat[key] === "bigint" ? fault.identity![key] : Number(fault.identity![key]) });
      }
      return stat;
    };
    if (kind === "owner" || kind === "reused") {
      vi.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => { fault.checkFd(args[0]); return forge(Reflect.apply(originalFstat, fs, args)); }) as typeof fs.fstatSync);
      vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => { fault.checkPath(args[0]); return forge(Reflect.apply(originalLstat, fs, args)); }) as typeof fs.lstatSync);
    }
    __setFsSafeTestHooksForTest({ drvfsMountObservation: () => mount });
    __setNativeLoaderForTest(() => ({ ...native!,
      async createStagedFile(parent, name) { const fd = await native!.createStagedFile!(parent, name); fault.trackFd(fd, path.join(directory, name)); return fd; },
      async renameReplaceAsync(parent, from, target, to) { await native!.renameReplaceAsync!(parent, from, target, to); fault.renamed(path.join(directory, from), path.join(directory, to)); },
      async renameNoReplaceAsync(parent, from, target, to) { await native!.renameNoReplaceAsync!(parent, from, target, to); fault.renamed(path.join(directory, from), path.join(directory, to)); },
      stagedFileMetadata(parent, name, fd) { fault.checkFd(fd); fault.checkPath(path.join(directory, name)); return native!.stagedFileMetadata!(parent, name, fd); },
      closeOwnedFd(fd) { native!.closeOwnedFd!(fd); fault.closed(fd); },
    }));
    configureFsSafeNative({ mode: "require" });
    const operation = (async () => {
      const options = { allowDrvfsRenameRecovery: kind !== "off", mode: kind === "restrictive" ? 0o400 : 0o600 };
      if (api === "root") await (await root(directory, options)).write("target", "payload");
      else { await using stage = await stageFileInDirectory({ directory, content: "payload", ...options }); await stage.publish("target", { overwrite: false }); }
    })();
    if (kind === "success" || kind === "restrictive") await operation;
    else await expect(operation).rejects.toBeTruthy();
    expect(fault.closes).toBe(1);
    if (kind === "success" || kind === "restrictive") expect(fs.readFileSync(filePath, "utf8")).toBe("payload");
  });
});
