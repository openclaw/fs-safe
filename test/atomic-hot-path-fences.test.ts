import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import type { ReplaceFileAtomicOptions, ReplaceFileAtomicSyncOptions } from "../src/replace-file.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe("atomic publication fences without beforeRename", () => {
  it("keeps the post-sync check when an async adapter changes the options", async () => {
    const directory = await tempRoot("fs-safe-atomic-sync-options-");
    const filePath = path.join(directory, "target");
    const options: ReplaceFileAtomicOptions = { filePath, content: "intended", syncParentDir: true };
    options.fileSystem = { promises: { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === directory) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          options.syncParentDir = false;
          await fs.rename(filePath, `${filePath}.owned`);
          await fs.writeFile(filePath, "replacement");
        };
      }
      return handle;
    } } };
    await expect(replaceFileAtomic(options)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(options.syncParentDir).toBe(false);
    expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
    expect(await fs.readFile(`${filePath}.owned`, "utf8")).toBe("intended");
  });

  it("keeps the post-sync check when a sync adapter changes the options", async () => {
    const directory = await tempRoot("fs-safe-atomic-sync-options-sync-");
    const filePath = path.join(directory, "target");
    const options: ReplaceFileAtomicSyncOptions = { filePath, content: "intended", syncParentDir: true };
    options.fileSystem = { ...fsSync, fsyncSync: (fd) => {
      fsSync.fsyncSync(fd);
      if (fsSync.fstatSync(fd).isDirectory()) {
        options.syncParentDir = false;
        fsSync.renameSync(filePath, `${filePath}.owned`);
        fsSync.writeFileSync(filePath, "replacement");
      }
    } };
    expect(() => replaceFileAtomicSync(options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(options.syncParentDir).toBe(false);
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("replacement");
    expect(fsSync.readFileSync(`${filePath}.owned`, "utf8")).toBe("intended");
  });

  it.each(["retry", "destination check"])("rejects a temp swap across an async %s", async (boundary) => {
    const directory = await tempRoot("fs-safe-atomic-fence-");
    const filePath = path.join(directory, "target");
    await fs.writeFile(filePath, "original");
    let temporary = "";
    let swapped = false;
    let renames = 0;
    const swap = async () => {
      await fs.rename(temporary, `${temporary}.owned`);
      await fs.writeFile(temporary, "replacement");
      swapped = true;
    };
    await expect(replaceFileAtomic({
      filePath, content: "intended", renameMaxRetries: 1, renameRetryBaseDelayMs: 0,
      destinationHardlinks: boundary === "destination check" ? "reject" : undefined,
      fileSystem: { promises: {
        ...fs,
        open: async (...args) => {
          const handle = await fs.open(...args);
          if (args[1] === "wx") temporary = String(args[0]);
          return handle;
        },
        lstat: (async (...args: Parameters<typeof fs.lstat>) => {
          if (boundary === "destination check" && temporary && String(args[0]) === filePath && !swapped) await swap();
          return await fs.lstat(...args);
        }) as typeof fs.lstat,
        rename: async () => {
          renames++;
          await swap();
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      } },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(renames).toBe(boundary === "retry" ? 1 : 0);
    expect(await fs.readFile(filePath, "utf8")).toBe("original");
    expect(await fs.readFile(temporary, "utf8")).toBe("replacement");
    expect(await fs.readFile(`${temporary}.owned`, "utf8")).toBe("intended");
  });

  it.each(["retry", "destination check"])("rejects a temp swap across a sync %s", async (boundary) => {
    const directory = await tempRoot("fs-safe-atomic-fence-sync-");
    const filePath = path.join(directory, "target");
    fsSync.writeFileSync(filePath, "original");
    let temporary = "";
    let swapped = false;
    let renames = 0;
    const swap = () => {
      fsSync.renameSync(temporary, `${temporary}.owned`);
      fsSync.writeFileSync(temporary, "replacement");
      swapped = true;
    };
    expect(() => replaceFileAtomicSync({
      filePath, content: "intended", renameMaxRetries: 1, renameRetryBaseDelayMs: 0,
      destinationHardlinks: boundary === "destination check" ? "reject" : undefined,
      fileSystem: {
        ...fsSync,
        openSync: (...args) => {
          const fd = fsSync.openSync(...args);
          if (args[1] === "wx") temporary = String(args[0]);
          return fd;
        },
        lstatSync: ((...args: Parameters<typeof fsSync.lstatSync>) => {
          if (boundary === "destination check" && temporary && String(args[0]) === filePath && !swapped) swap();
          return fsSync.lstatSync(...args);
        }) as typeof fsSync.lstatSync,
        renameSync: () => {
          renames++;
          swap();
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      },
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(renames).toBe(boundary === "retry" ? 1 : 0);
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("original");
    expect(fsSync.readFileSync(temporary, "utf8")).toBe("replacement");
    expect(fsSync.readFileSync(`${temporary}.owned`, "utf8")).toBe("intended");
  });
});
