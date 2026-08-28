import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSecretFileSync } from "../src/secret-file.js";
import { readSecretFile } from "../src/secret-read-async.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());

describe.each(["sync", "async"] as const)("%s secret identity", (kind) => {
  async function read(filePath: string, rejectSymlink = false) {
    return kind === "sync"
      ? readSecretFileSync(filePath, "token", { rejectSymlink })
      : await readSecretFile(filePath, "token", { rejectSymlink });
  }

  it.each([false, true])("keeps preview, descriptor, target, and input inspections ordered (rejectSymlink=%s)", async (rejectSymlink) => {
    const root = await tempRoot("fs-safe-secret-inspection-order-");
    const filePath = path.join(root, "token");
    await fs.writeFile(filePath, "secret");
    const inspections: string[] = [];
    if (kind === "sync") {
      for (const operation of ["statSync", "lstatSync", "fstatSync"] as const) {
        const real = fsSync[operation].bind(fsSync);
        vi.spyOn(fsSync, operation).mockImplementation((...args) => {
          if (args[1]?.bigint) inspections.push(operation.replace("Sync", ""));
          return real(...args as Parameters<typeof real>);
        });
      }
    } else {
      for (const operation of ["stat", "lstat"] as const) {
        const real = fs[operation].bind(fs);
        vi.spyOn(fs, operation).mockImplementation(async (...args) => {
          if (args[1]?.bigint) inspections.push(operation);
          return await real(...args);
        });
      }
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        const handle = await open(...args);
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          if (options?.bigint) inspections.push("fstat");
          return await stat(options);
        });
        return handle;
      });
    }
    await expect(read(filePath, rejectSymlink)).resolves.toBe("secret");
    const inputOperation = rejectSymlink ? "lstat" : "stat";
    expect(inspections).toEqual([inputOperation, "fstat", "lstat", inputOperation]);
  });

  it.each([false, true])("refuses a real replacement after opening (rejectSymlink=%s)", async (rejectSymlink) => {
    const root = await tempRoot("fs-safe-secret-open-replacement-");
    const filePath = path.join(root, "token");
    const oldPath = path.join(root, "original");
    await fs.writeFile(filePath, "original");
    let close: ReturnType<typeof vi.spyOn>;
    let bytes: ReturnType<typeof vi.spyOn>;
    let pinnedFd: number;
    if (kind === "sync") {
      const open = fsSync.openSync.bind(fsSync);
      close = vi.spyOn(fsSync, "closeSync");
      bytes = vi.spyOn(fsSync, "readSync");
      vi.spyOn(fsSync, "openSync").mockImplementationOnce((...args) => {
        const fd = open(...args);
        pinnedFd = fd;
        fsSync.renameSync(filePath, oldPath);
        fsSync.writeFileSync(filePath, "replacement");
        return fd;
      });
    } else {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        const handle = await open(...args);
        close = vi.spyOn(handle, "close");
        bytes = vi.spyOn(handle, "read");
        await fs.rename(filePath, oldPath);
        await fs.writeFile(filePath, "replacement");
        return handle;
      });
    }
    await expect(read(filePath, rejectSymlink)).rejects.toMatchObject({ code: "path-mismatch" });
    if (kind === "sync") {
      expect(close!.mock.calls.filter(([fd]) => fd === pinnedFd)).toHaveLength(1);
      expect(() => fsSync.fstatSync(pinnedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    } else {
      expect(close!).toHaveBeenCalledTimes(1);
    }
    expect(bytes!).not.toHaveBeenCalled();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
  });

  it("refuses a real replacement between preview and realpath resolution", async () => {
    const root = await tempRoot("fs-safe-secret-preview-replacement-");
    const filePath = path.join(root, "token");
    await fs.writeFile(filePath, "original");
    if (kind === "sync") {
      const realpath = fsSync.realpathSync.bind(fsSync);
      vi.spyOn(fsSync, "realpathSync").mockImplementationOnce((...args) => {
        fsSync.renameSync(filePath, path.join(root, "original"));
        fsSync.writeFileSync(filePath, "replacement");
        return realpath(...args);
      });
    } else {
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args) => {
        await fs.rename(filePath, path.join(root, "original"));
        await fs.writeFile(filePath, "replacement");
        return await realpath(...args);
      });
    }
    await expect(read(filePath)).rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("refuses an allowed alias retargeted while its original target remains", async () => {
    const root = await tempRoot("fs-safe-secret-alias-replacement-");
    const filePath = path.join(root, "token");
    const original = path.join(root, "original");
    const replacement = path.join(root, "replacement");
    await fs.writeFile(original, "original");
    await fs.writeFile(replacement, "replacement");
    await fs.symlink(original, filePath, "file");
    if (kind === "sync") {
      const open = fsSync.openSync.bind(fsSync);
      vi.spyOn(fsSync, "openSync").mockImplementationOnce((...args) => {
        const fd = open(...args);
        fsSync.unlinkSync(filePath);
        fsSync.symlinkSync(replacement, filePath, "file");
        return fd;
      });
    } else {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        const handle = await open(...args);
        await fs.unlink(filePath);
        await fs.symlink(replacement, filePath, "file");
        return handle;
      });
    }
    await expect(read(filePath)).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.readFile(original, "utf8")).resolves.toBe("original");
  });
});
