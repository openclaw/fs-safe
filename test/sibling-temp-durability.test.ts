import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
});

async function fixture() {
  const dir = await tempRoot("fs-safe-sibling-durability-");
  const final = path.join(dir, "final");
  await fs.writeFile(final, "old");
  let temporary = "";
  const result = { filename: "final", opaque: {} };
  const options = {
    dir, chmodDir: false,
    writeTemp: async (candidate: string) => {
      temporary = candidate;
      await fs.writeFile(candidate, "new", { mode: 0o644 });
      return result;
    },
    resolveFinalPath: (value: typeof result) => path.join(dir, value.filename),
  };
  return { dir, final, options, result, temp: () => temporary };
}

itPosix.each([undefined, 0, 0o640])("retains one writable descriptor for mode %s, fsync, rename and verification", async (mode) => {
  const f = await fixture();
  const operations: string[] = [];
  const open = fs.open.bind(fs);
  const rename = fs.rename.bind(fs);
  let retained = -1;
  let stageOpens = 0;
  let closed = 0;
  vi.spyOn(fs, "chmod").mockRejectedValue(new Error("pathname chmod forbidden"));
  vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, openMode) => {
    const handle = await open(candidate, flags, openMode);
    if (candidate === f.temp()) {
      stageOpens++;
      retained = handle.fd;
      expect(Number(flags) & fsSync.constants.O_RDWR).toBe(fsSync.constants.O_RDWR);
      expect(Number(flags) & (fsSync.constants.O_CREAT | fsSync.constants.O_TRUNC)).toBe(0);
      const chmod = handle.chmod.bind(handle);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "chmod").mockImplementation(async (value) => {
        operations.push("chmod");
        await chmod(value);
      });
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        operations.push("file-sync");
        await sync();
      });
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closed++;
        operations.push("close");
        await close();
      });
    } else if (candidate === f.dir) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        operations.push("parent-sync");
        await sync();
      });
    }
    return handle;
  });
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    operations.push("rename");
    const descriptor = fsSync.fstatSync(retained, { bigint: true });
    expect((await fs.lstat(from, { bigint: true })).ino).toBe(descriptor.ino);
    expect(Number(descriptor.mode & 0o777n)).toBe(mode ?? 0o600);
    await rename(from, to);
  });
  const actual = await writeSiblingTempFile({ ...f.options, mode });
  expect(actual.result).toBe(f.result);
  expect(actual.filePath).toBe(f.final);
  expect(operations).toEqual(["chmod", "file-sync", "rename", "parent-sync", "close"]);
  expect(stageOpens).toBe(1);
  expect(closed).toBe(1);
  expect((await fs.stat(f.final)).mode & 0o777).toBe(mode ?? 0o600);
  expect(() => fsSync.fstatSync(retained)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it("honors explicit sync opt-outs without opting out of identity or mode checks", async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  const syncs = vi.fn();
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    vi.spyOn(handle, "sync").mockImplementation(async () => { syncs(); });
    return handle;
  });
  await writeSiblingTempFile({ ...f.options, syncTempFile: false, syncParentDir: false });
  expect(syncs).not.toHaveBeenCalled();
  expect(await fs.readFile(f.final, "utf8")).toBe("new");
});

it.each(["chmod", "sync"] as const)("propagates descriptor %s failures before publication and cleans the admitted stage", async (operation) => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  const failure = Object.assign(new Error(`${operation} failed`), { code: "EIO" });
  let handle: FileHandle | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const opened = await open(...args);
    if (args[0] === f.temp()) {
      handle = opened;
      vi.spyOn(opened, operation).mockRejectedValue(failure);
    }
    return opened;
  });
  await expect(writeSiblingTempFile(f.options)).rejects.toBe(failure);
  expect(await fs.readFile(f.final, "utf8")).toBe("old");
  await expect(fs.lstat(f.temp())).rejects.toMatchObject({ code: "ENOENT" });
  expect(handle?.fd).toBe(-1);
});

it("retains the existing EPERM file-sync exception", async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.temp()) vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error("unsupported"), { code: "EPERM" }));
    return handle;
  });
  await writeSiblingTempFile(f.options);
  expect(await fs.readFile(f.final, "utf8")).toBe("new");
});

itPosix("keeps parent sync best-effort but still verifies the published name afterward", async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.dir) vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error("sync failed"), { code: "EIO" }));
    return handle;
  });
  await writeSiblingTempFile(f.options);
  expect(await fs.readFile(f.final, "utf8")).toBe("new");
});

itPosix("detects a published replacement during parent fsync without chmod or rollback", async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.dir) vi.spyOn(handle, "sync").mockImplementation(async () => {
      await fs.rename(f.final, path.join(f.dir, "moved"));
      await fs.writeFile(f.final, "replacement", { mode: 0o644 });
    });
    return handle;
  });
  await expect(writeSiblingTempFile(f.options)).rejects.toMatchObject({ code: "path-mismatch" });
  expect(await fs.readFile(f.final, "utf8")).toBe("replacement");
  expect((await fs.stat(f.final)).mode & 0o777).toBe(0o644);
});

it.each(["unchanged", "replaced", "hardlinked"] as const)("bounds cleanup retries to the admitted single-link identity (%s)", async (state) => {
  const f = await fixture();
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
  await expect(writeSiblingTempFile(f.options)).rejects.toMatchObject({ code: "EACCES" });
  expect(await fs.readFile(f.temp(), "utf8")).toBe("new");
  if (state === "replaced") {
    await rename(f.temp(), path.join(f.dir, "moved"));
    await fs.writeFile(f.temp(), "replacement");
  } else if (state === "hardlinked") await fs.link(f.temp(), path.join(f.dir, "alias"));
  __cleanupRegisteredTempPathsForTest();
  if (state === "unchanged") await expect(fs.lstat(f.temp())).rejects.toMatchObject({ code: "ENOENT" });
  else expect(await fs.readFile(f.temp(), "utf8")).toBe(state === "replaced" ? "replacement" : "new");
  expect(await fs.readFile(f.final, "utf8")).toBe("old");
});

it("preserves a replacement appearing after cleanup starts", async () => {
  const f = await fixture();
  const rename = fs.rename.bind(fs);
  const open = fs.open.bind(fs);
  let cleanup = false;
  vi.spyOn(fs, "rename").mockImplementation(async () => {
    cleanup = true;
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.temp()) {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) => {
        if (cleanup) {
          cleanup = false;
          await rename(f.temp(), path.join(f.dir, "moved"));
          await fs.mkdir(f.temp());
          await fs.writeFile(path.join(f.temp(), "sentinel"), "keep");
        }
        return await stat(options);
      });
    }
    return handle;
  });
  await expect(writeSiblingTempFile(f.options)).rejects.toMatchObject({ code: "EACCES" });
  __cleanupRegisteredTempPathsForTest();
  expect(await fs.readFile(path.join(f.temp(), "sentinel"), "utf8")).toBe("keep");
});

itPosix("applies the directory mode through a descriptor and preserves chmodDir:false", async () => {
  const f = await fixture();
  await fs.chmod(f.dir, 0o755);
  const chmod = vi.spyOn(fs, "chmod").mockRejectedValue(new Error("path chmod forbidden"));
  await writeSiblingTempFile(f.options);
  expect((await fs.stat(f.dir)).mode & 0o777).toBe(0o755);
  await writeSiblingTempFile({ ...f.options, chmodDir: true });
  expect((await fs.stat(f.dir)).mode & 0o777).toBe(0o700);
  expect(chmod).not.toHaveBeenCalled();
});

it("preserves both an operation error and a descriptor-close error", async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  const failure = new Error("sync failed");
  const closeFailure = new Error("close failed");
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.temp()) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "sync").mockRejectedValue(failure);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        throw closeFailure;
      });
    }
    return handle;
  });
  await expect(writeSiblingTempFile(f.options)).rejects.toMatchObject({ errors: [failure, closeFailure] });
  expect(await fs.readFile(f.final, "utf8")).toBe("old");
  await expect(fs.lstat(f.temp())).rejects.toMatchObject({ code: "ENOENT" });
});

it("validates resolver output before descriptor mutation and rejects its own temp name", async () => {
  const f = await fixture();
  await expect(writeSiblingTempFile({
    ...f.options,
    resolveFinalPath: () => f.temp(),
  })).rejects.toMatchObject({ code: "invalid-path" });
  await expect(fs.lstat(f.temp())).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(f.final, "utf8")).toBe("old");
});
