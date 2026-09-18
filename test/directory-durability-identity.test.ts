import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureDurableDirectory,
  pinDirectory,
  syncDirectory,
  syncDirectorySync,
} from "../src/directory-durability.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { openStagedDirectory } from "../src/staged-directory.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const highInode = 2n ** 53n;

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

async function directoryFixture() {
  const base = await tempRoot("fs-safe-durability-identity-");
  const directory = path.join(base, "directory");
  const displaced = path.join(base, "displaced");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "keep"), "original");
  return { base, directory, displaced };
}

async function pinWithSyncSpy(directory: string) {
  const open = fs.open.bind(fs);
  let handle: FileHandle | undefined;
  const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    handle = await open(...args);
    return handle;
  });
  try {
    const pinned = await pinDirectory(directory);
    return { pinned, handle: handle!, sync: vi.spyOn(handle!, "sync") };
  } finally {
    opening.mockRestore();
  }
}

function injectWideIdentity(directory: string, displaced: string) {
  const lstat = fsSync.lstatSync.bind(fsSync);
  const fstat = fsSync.fstatSync.bind(fsSync);
  const original = lstat(directory, { bigint: true });
  let replacement: BigIntStats | undefined;
  const project = (stat: Stats | BigIntStats, exact: BigIntStats) => {
    const ino = exact.dev === original.dev && exact.ino === original.ino ? highInode :
      replacement && exact.dev === replacement.dev && exact.ino === replacement.ino ? highInode + 1n : undefined;
    return ino === undefined ? stat : Object.assign(Object.create(stat), {
      ino: typeof stat.ino === "bigint" ? ino : Number(ino),
    });
  };
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    return String(args[0]) === directory ? project(stat, lstat(directory, { bigint: true })) : stat;
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) =>
    project(fstat(...args), fstat(args[0], { bigint: true })));
  return {
    original,
    fstat,
    replace() {
      fsSync.renameSync(directory, displaced);
      fsSync.mkdirSync(directory);
      fsSync.writeFileSync(path.join(directory, "keep"), "replacement");
      replacement = lstat(directory, { bigint: true });
      expect(replacement.ino).not.toBe(original.ino);
      expect(Number(highInode)).toBe(Number(highInode + 1n));
    },
  };
}

describe("exact directory durability identities", () => {
  itPosix("keeps numeric receipt metadata tied to the admitted directory through an A-B-A pathname swap", async () => {
    const { base, directory, displaced } = await directoryFixture();
    await fs.chmod(directory, 0o777);
    const before = await fs.lstat(directory);
    const substituted = path.join(base, "substituted");
    const lstat = fsSync.lstatSync.bind(fsSync);
    let replaced = false;
    let restored = false;
    const restore = () => {
      fsSync.renameSync(directory, substituted);
      fsSync.renameSync(displaced, directory);
      restored = true;
    };
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) !== directory) return lstat(...args);
      if (replaced && !restored && args[1]?.bigint) restore();
      const stat = lstat(...args);
      if (!replaced && typeof stat.ino === "bigint") {
        fsSync.renameSync(directory, displaced);
        fsSync.mkdirSync(directory, { mode: 0o700 });
        replaced = true;
      } else if (replaced && !restored) {
        restore();
      }
      return stat;
    });
    const pinned = await pinDirectory(directory);
    try {
      await expect(pinned.assertCurrent()).resolves.toBeUndefined();
      expect(replaced && restored).toBe(true);
      expect(pinned.receipt.identity).toBeInstanceOf(fsSync.Stats);
      expect(Object.keys(pinned.receipt.identity).sort()).toEqual(Object.keys(before).sort());
      expect(pinned.receipt.identity).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
      expect(pinned.receipt.identity.isDirectory()).toBe(true);
      expect(pinned.receipt.identity.isFile()).toBe(false);
      for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
        expect(pinned.receipt.identity[`${field}Ms`]).toBe(before[`${field}Ms`]);
        expect(pinned.receipt.identity[field]).toEqual(before[field]);
      }
      expect((await fs.lstat(substituted)).mode & 0o777).toBe(0o700);
      expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("original");
    } finally {
      await pinned.close();
    }
  });

  itPosix("preserves Node's negative and fractional timestamp metadata", async () => {
    const { directory } = await directoryFixture();
    await fs.utimes(directory, new Date(-12_345), 1_234_567_890.1234567);
    const before = await fs.lstat(directory);
    expect(before.atimeMs).toBeLessThan(0);
    expect(before.mtimeMs % 1).not.toBe(0);
    const pinned = await pinDirectory(directory);
    try {
      for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
        expect(pinned.receipt.identity[`${field}Ms`]).toBe(before[`${field}Ms`]);
        expect(pinned.receipt.identity[field]).toEqual(before[field]);
      }
    } finally {
      await pinned.close();
    }
  });

  itPosix("rejects a real replacement hidden by rounded numeric inodes without syncing the old descriptor", async () => {
    const { directory, displaced } = await directoryFixture();
    const injected = injectWideIdentity(directory, displaced);
    const { pinned, handle, sync } = await pinWithSyncSpy(directory);
    try {
      expect(pinned.receipt.identity.ino).toBe(Number(highInode));
      injected.replace();
      await expect(pinned.assertCurrent()).rejects.toMatchObject({ code: "path-mismatch" });
      await expect(pinned.sync()).rejects.toMatchObject({ code: "path-mismatch" });
      expect(sync).not.toHaveBeenCalled();
      expect(injected.fstat(handle.fd, { bigint: true }).ino).toBe(injected.original.ino);
      expect(await fs.readFile(path.join(displaced, "keep"), "utf8")).toBe("original");
      expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("replacement");
    } finally {
      await pinned.close();
    }
  });

  itPosix.each(["before sync", "during sync"] as const)("fences synchronous replacement %s and retains the original descriptor", async timing => {
    const { directory, displaced } = await directoryFixture();
    const injected = injectWideIdentity(directory, displaced);
    const open = fsSync.openSync.bind(fsSync);
    const fsync = fsSync.fsyncSync.bind(fsSync);
    let descriptor = -1;
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (String(args[0]) === directory) {
        descriptor = fd;
        if (timing === "before sync") injected.replace();
      }
      return fd;
    });
    const sync = vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
      if (timing === "during sync") injected.replace();
      expect(injected.fstat(fd, { bigint: true }).ino).toBe(injected.original.ino);
      fsync(fd);
    });

    expect(() => syncDirectorySync(directory)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(sync).toHaveBeenCalledTimes(timing === "before sync" ? 0 : 1);
    expect(() => injected.fstat(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(await fs.readFile(path.join(displaced, "keep"), "utf8")).toBe("original");
    expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("replacement");
  });

  itPosix("rejects a real replacement whose Windows pathname identity remains entirely unknown", async () => {
    const { directory, displaced } = await directoryFixture();
    const { pinned, sync: handleSync } = await pinWithSyncSpy(directory);
    await fs.rename(directory, displaced);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "keep"), "replacement");
    const lstat = fsSync.lstatSync.bind(fsSync);
    let observations = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (String(args[0]) !== directory) return stat;
      observations++;
      const zero = typeof stat.ino === "bigint" ? 0n : 0;
      return Object.assign(Object.create(stat), { dev: zero, ino: zero });
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const sync = vi.spyOn(fsSync, "fsyncSync");
    try {
      for (const run of [() => pinned.assertCurrent(), () => pinned.sync(), () => syncDirectorySync(pinned.receipt)]) {
        observations = 0;
        await expect(async () => await run()).rejects.toMatchObject({ code: "path-mismatch" });
        expect(observations).toBe(2);
      }
      expect(sync).not.toHaveBeenCalled();
      expect(handleSync).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(displaced, "keep"), "utf8")).toBe("original");
      expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("replacement");
    } finally {
      await pinned.close();
    }
  });

  itPosix("keeps wide library receipts usable by pins, sync, expected identity, publication, and staging", async () => {
    const { base, directory, displaced } = await directoryFixture();
    injectWideIdentity(directory, displaced);
    configureFsSafeNative({ mode: "off" });
    const receipt = await ensureDurableDirectory({ directoryPath: directory });
    expect(typeof receipt.identity.size).toBe("number");
    expect(typeof receipt.identity.mode).toBe("number");
    expect(receipt.identity.isDirectory()).toBe(true);
    expect(receipt.identity.ino).toBe(Number(highInode));
    const pinned = await pinDirectory(receipt);
    try {
      await expect(pinned.assertCurrent()).resolves.toBeUndefined();
      await expect(syncDirectory(receipt)).resolves.toEqual({ status: "synced" });
      expect(syncDirectorySync(receipt)).toEqual({ status: "synced" });
      await expect(ensureDurableDirectory({ directoryPath: directory, expectedExistingIdentity: receipt.identity }))
        .resolves.toMatchObject({ path: directory, parentSync: { status: "not-needed" } });
      const sourcePath = path.join(base, "source");
      const targetPath = path.join(directory, "published");
      await fs.writeFile(sourcePath, "published content");
      await expect(publishFileExclusive({ sourcePath, targetPath, parentReceipt: receipt, strategy: "link-required" }))
        .resolves.toMatchObject({ method: "hardlink", directorySync: { status: "synced" } });
      expect(await fs.readFile(targetPath, "utf8")).toBe("published content");
      const staged = openStagedDirectory(receipt);
      try {
        expect(staged.receipt.identity.ino).toBe(highInode);
      } finally {
        fsSync.closeSync(staged.fd);
      }
    } finally {
      await pinned.close();
    }
  });

  itPosix("does not let public receipt or Stats mutation authorize a replacement", async () => {
    const { directory, displaced } = await directoryFixture();
    const pinned = await pinDirectory(directory);
    const receipt = pinned.receipt;
    try {
      await fs.rename(directory, displaced);
      await fs.mkdir(directory);
      const replacement = await fs.lstat(directory);
      Object.assign(receipt.identity, { dev: replacement.dev, ino: replacement.ino });
      await expect(pinned.assertCurrent()).rejects.toMatchObject({ code: "path-mismatch" });
      await expect(pinDirectory(receipt)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(() => syncDirectorySync(receipt)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      await expect(ensureDurableDirectory({ directoryPath: directory, expectedExistingIdentity: receipt.identity }))
        .rejects.toMatchObject({ code: "path-mismatch" });
      receipt.path = displaced;
      receipt.realPath = displaced;
      receipt.identity = await fs.lstat(displaced);
      await expect(pinned.assertCurrent()).rejects.toMatchObject({ code: "path-mismatch" });
      await expect(pinDirectory(receipt)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(() => openStagedDirectory(receipt)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    } finally {
      await pinned.close();
    }
  });

  itPosix("accepts exact bigint expected identity and rejects a rounded replacement", async () => {
    const { directory, displaced } = await directoryFixture();
    const injected = injectWideIdentity(directory, displaced);
    const expectedExistingIdentity = { dev: injected.original.dev, ino: highInode };
    await expect(ensureDurableDirectory({ directoryPath: directory, expectedExistingIdentity }))
      .resolves.toMatchObject({ parentSync: { status: "not-needed" } });
    injected.replace();
    await expect(ensureDurableDirectory({ directoryPath: directory, expectedExistingIdentity }))
      .rejects.toMatchObject({ code: "path-mismatch" });
  });

  itPosix.each(["path", "realPath", "device", "inode", "identity"] as const)(
    "keeps a live pin current but rejects new admissions after public %s mutation",
    async field => {
      const { base, directory } = await directoryFixture();
      const other = path.join(base, "other");
      await fs.mkdir(other);
      const pinned = await pinDirectory(directory);
      const receipt = pinned.receipt;
      try {
        if (field === "path") receipt.path = other;
        else if (field === "realPath") receipt.realPath = other;
        else if (field === "device") receipt.identity.dev = receipt.identity.dev === 0 ? 1 : 0;
        else if (field === "inode") receipt.identity.ino = receipt.identity.ino === 0 ? 1 : 0;
        else receipt.identity = await fs.lstat(other);
        await expect(pinned.assertCurrent()).resolves.toBeUndefined();
        await expect(pinned.sync()).resolves.toEqual({ status: "synced" });
        await expect(pinDirectory(receipt)).rejects.toMatchObject({ code: "path-mismatch" });
        await expect(syncDirectory(receipt)).rejects.toMatchObject({ code: "path-mismatch" });
        expect(() => syncDirectorySync(receipt)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
        expect(() => openStagedDirectory(receipt)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
        const sourcePath = path.join(base, "source");
        const targetPath = path.join(directory, "target");
        await fs.writeFile(sourcePath, "source");
        await expect(publishFileExclusive({ sourcePath, targetPath, parentReceipt: receipt, strategy: "link-required" }))
          .rejects.toMatchObject({ code: "path-mismatch" });
        expect(await fs.readdir(directory)).toEqual(["keep"]);
        expect(await fs.readdir(other)).toEqual([]);
      } finally {
        await pinned.close();
      }
    },
  );

  it("accepts a safe external numeric receipt and snapshots it before asynchronous admission", async () => {
    const { directory } = await directoryFixture();
    const lstat = fsSync.lstatSync.bind(fsSync);
    const fstat = fsSync.fstatSync.bind(fsSync);
    const project = (stat: Stats | BigIntStats) => Object.assign(Object.create(stat), {
      dev: typeof stat.dev === "bigint" ? 1n : 1,
      ino: typeof stat.ino === "bigint" ? 42n : 42,
    });
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      return String(args[0]) === directory ? project(stat) : stat;
    });
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => project(fstat(...args)));
    const identity = fsSync.lstatSync(directory);
    const receipt = { path: directory, realPath: directory, identity };
    const admission = pinDirectory(receipt);
    identity.ino = 43;
    receipt.path = path.join(directory, "changed");
    const pinned = await admission;
    try {
      await expect(pinned.assertCurrent()).resolves.toBeUndefined();
      expect(pinned.receipt.path).toBe(directory);
      expect(pinned.receipt.identity.ino).toBe(42);
    } finally {
      await pinned.close();
    }
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 1.5, "windows zero"] as const)(
    "rejects unprovable external numeric identity %s before opening or creating",
    async value => {
      const { directory } = await directoryFixture();
      const identity = await fs.lstat(directory);
      if (value === "windows zero") vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      identity.ino = value === "windows zero" ? 0 : value;
      const receipt = { path: directory, realPath: directory, identity };
      const open = vi.spyOn(fs, "open");
      const openSync = vi.spyOn(fsSync, "openSync");
      const create = vi.fn();
      await expect(pinDirectory(receipt)).rejects.toMatchObject({ code: "path-mismatch" });
      await expect(syncDirectory(receipt)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(() => syncDirectorySync(receipt)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      await expect(ensureDurableDirectory({ directoryPath: directory, expectedExistingIdentity: identity, create }))
        .rejects.toMatchObject({ code: "path-mismatch" });
      expect(open).not.toHaveBeenCalled();
      expect(openSync).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
});

describe.each(["pathname", "descriptor"] as const)("Windows unknown %s directory identity", surface => {
  it.each(["persistent unknown", "known mismatch"] as const)("rejects %s with bounded retry before async or sync flushing", async scenario => {
    const { directory } = await directoryFixture();
    const { pinned, sync: handleSync } = await pinWithSyncSpy(directory);
    const lstat = fsSync.lstatSync.bind(fsSync);
    const fstat = fsSync.fstatSync.bind(fsSync);
    let observations = 0;
    const inspect = (stat: Stats | BigIntStats) => {
      if (typeof stat.ino !== "bigint") return stat;
      observations++;
      return Object.assign(Object.create(stat), {
        dev: 0n,
        ino: scenario === "known mismatch" ? stat.ino + 1n : stat.ino,
      });
    };
    if (surface === "pathname") {
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        return String(args[0]) === directory ? inspect(stat) : stat;
      });
    } else {
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => inspect(fstat(...args)));
    }
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const sync = vi.spyOn(fsSync, "fsyncSync");
    try {
      for (const run of [() => pinned.assertCurrent(), () => pinned.sync(), () => syncDirectorySync(pinned.receipt)]) {
        observations = 0;
        await expect(async () => await run()).rejects.toMatchObject({ code: "path-mismatch" });
        expect(observations).toBe(scenario === "known mismatch" ? 1 : 2);
      }
      expect(sync).not.toHaveBeenCalled();
      expect(handleSync).not.toHaveBeenCalled();
    } finally {
      await pinned.close();
    }
  });

  it("recovers from one unknown observation on the same path or descriptor", async () => {
    const { directory } = await directoryFixture();
    const pinned = await pinDirectory(directory);
    const lstat = fsSync.lstatSync.bind(fsSync);
    const fstat = fsSync.fstatSync.bind(fsSync);
    let observations = 0;
    const inspect = (stat: Stats | BigIntStats) => {
      if (typeof stat.ino !== "bigint") return stat;
      observations++;
      return observations === 1 ? Object.assign(Object.create(stat), { dev: 0n }) : stat;
    };
    if (surface === "pathname") {
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        return String(args[0]) === directory ? inspect(stat) : stat;
      });
    } else {
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => inspect(fstat(...args)));
    }
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const open = vi.spyOn(fs, "open");
    try {
      await expect(pinned.assertCurrent()).resolves.toBeUndefined();
      expect(observations).toBe(2);
      expect(open).not.toHaveBeenCalled();
    } finally {
      await pinned.close();
    }
  });
});
