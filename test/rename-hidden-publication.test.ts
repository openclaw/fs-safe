import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { writeJsonSync } from "../src/json.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { root } from "../src/root.js";
import { stageFileInDirectory } from "../src/advanced.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { writeFileSyncAtomic } from "../src/file-store-sync-write.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { hideRenamedFileUntilClose } from "./helpers/rename-hidden.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); __resetNativeLoaderForTest(); });
const writers = {
  async: (filePath: string) => replaceFileAtomic({ filePath, content: "payload", syncTempFile: true, syncParentDir: true }),
  sync: (filePath: string) => replaceFileAtomicSync({ filePath, content: "payload", syncTempFile: true, syncParentDir: true }),
  compatibility: (filePath: string) => replaceFileAtomic({ filePath, content: "payload", renameIdentity: "verify-content-with-lock" }),
  json: (filePath: string) => writeJsonSync(filePath, { value: "payload" }),
  store: (filePath: string) => writeFileSyncAtomic({ rootDir: path.dirname(filePath), filePath,
    content: "payload", privateMode: false, durable: true, dirMode: 0o700, mode: 0o600 }),
  sibling: (filePath: string) => writeSiblingTempFile({ dir: path.dirname(filePath),
    writeTemp: name => fsp.writeFile(name, "payload"), resolveFinalPath: () => filePath, syncParentDir: true }),
  root: async (filePath: string) => { configureFsSafeNative({ mode: "off" }); await (await root(path.dirname(filePath))).write(path.basename(filePath), "payload"); },
};

describe.each(Object.entries(writers))("%s publication on rename-hidden filesystems", (_, write) => {
  it("closes once and verifies the original inode without a retry delay", async () => {
    const filePath = path.join(await tempRoot("rename-hidden-"), "target");
    const fault = hideRenamedFileUntilClose(filePath);
    await write(filePath);
    expect(fault.failures).toBeGreaterThan(0);
    expect(fault.closes).toBe(1);
    expect(fault.hidden).toBe(0);
    expect(fs.lstatSync(filePath, { bigint: true })).toMatchObject({ dev: fault.identity!.dev, ino: fault.identity!.ino });
    expect(fs.readFileSync(filePath, "utf8")).toContain("payload");
  });

  it.each(["replacement", "deletion"])("rejects %s at close and preserves the final namespace", async kind => {
    const filePath = path.join(await tempRoot("rename-hidden-swap-"), "target");
    const fault = hideRenamedFileUntilClose(filePath, () => {
      // Keep the old inode allocated so this is an actual identity substitution.
      fs.renameSync(filePath, `${filePath}.retained`);
      if (kind === "replacement") fs.writeFileSync(filePath, "payload");
    });
    await expect(Promise.resolve().then(() => write(filePath))).rejects.toBeTruthy();
    expect(fault.closes).toBe(1);
    expect(fs.readFileSync(`${filePath}.retained`, "utf8")).toContain("payload");
    if (kind === "replacement") expect(fs.readFileSync(filePath, "utf8")).toBe("payload");
    else expect(fs.existsSync(filePath)).toBe(false);
  });
});

let native: ReturnType<typeof __loadBundledNativeForTest> | undefined;
try { if (process.platform !== "win32") native = __loadBundledNativeForTest(); } catch { /* native CI owns this case */ }
describe.runIf(native)("native root rename-hidden publication", () => {
  it.each(["root", "stage", "exclusive"].flatMap(api => ["original", "replacement", "deletion"].map(kind => ({ api, kind }))))(
    "verifies $kind after closing the $api stage", async ({ api, kind }) => {
    const directory = await tempRoot("native-rename-hidden-");
    const filePath = path.join(directory, "target");
    const fault = hideRenamedFileUntilClose(filePath, kind === "original" ? undefined : () => {
      fs.renameSync(filePath, `${filePath}.retained`);
      if (kind === "replacement") fs.writeFileSync(filePath, "payload");
    });
    __setNativeLoaderForTest(() => ({ ...native!,
      async createStagedFile(parent, name) {
        const fd = await native!.createStagedFile!(parent, name);
        fault.trackFd(fd, path.join(directory, name)); return fd;
      },
      async renameReplaceAsync(parent, from, target, to) {
        await native!.renameReplaceAsync!(parent, from, target, to);
        fault.renamed(path.join(directory, from), path.join(directory, to));
      },
      async renameNoReplaceAsync(parent, from, target, to) {
        await native!.renameNoReplaceAsync!(parent, from, target, to);
        fault.renamed(path.join(directory, from), path.join(directory, to));
      },
      renameNoReplace(parent, from, target, to) {
        native!.renameNoReplace!(parent, from, target, to);
        fault.renamed(path.join(directory, from), path.join(directory, to));
      },
      stagedFileMetadata(parent, name, fd) { fault.checkFd(fd); fault.checkPath(path.join(directory, name)); return native!.stagedFileMetadata!(parent, name, fd); },
      stagedFileMatches(parent, name, fd) { fault.checkFd(fd); fault.checkPath(path.join(directory, name)); return native!.stagedFileMatches!(parent, name, fd); },
      closeOwnedFd(fd) { native!.closeOwnedFd!(fd); fault.closed(fd); },
    }));
    configureFsSafeNative({ mode: "require" });
    const operation = (async () => {
      if (api === "root") return (await root(directory)).write("target", "payload");
      if (api === "stage") {
        await using stage = await stageFileInDirectory({ directory, content: "payload" });
        return stage.publish("target", { overwrite: false });
      }
      const sourcePath = path.join(directory, "source");
      await fsp.writeFile(sourcePath, "payload");
      return publishFileExclusive({ sourcePath, targetPath: filePath, strategy: "rename-noreplace" });
    })();
    if (kind === "original") {
      await operation;
      expect(fs.lstatSync(filePath, { bigint: true })).toMatchObject({ dev: fault.identity!.dev, ino: fault.identity!.ino });
    } else await expect(operation).rejects.toBeTruthy();
    expect(fault.failures).toBeGreaterThan(0);
    expect(fault.closes).toBe(1);
  });
});
