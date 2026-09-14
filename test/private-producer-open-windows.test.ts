import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __cleanupRegisteredTempPathsForTest();
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function fixture(syncTempFile = false) {
  const dir = await tempRoot("fs-safe-private-open-");
  const final = path.join(dir, "final.bin");
  await fs.writeFile(final, "old");
  let candidate = "";
  const publish = (write: (file: string) => Promise<void>) => writeSiblingTempFile({
    dir,
    chmodDir: false,
    producerIsolation: "private-directory",
    syncParentDir: false,
    syncTempFile,
    writeTemp: async (file) => {
      candidate = file;
      await write(file);
    },
    resolveFinalPath: () => final,
  });
  return { candidate: () => candidate, dir, final, publish };
}

it.skipIf(process.platform !== "win32")(
  "uses write-only admission without a completed-file data-read open on Windows",
  async () => {
    const target = await fixture();
    const open = vi.spyOn(fs, "open");
    await target.publish((file) => fs.writeFile(file, Buffer.alloc(256 * 1024, 0x5a)));
    const sourceCalls = open.mock.calls.filter(([file]) => String(file) === target.candidate());
    expect(sourceCalls.map(([, flags]) => flags)).toEqual([fsSync.constants.O_WRONLY]);
    expect((await fs.readFile(target.final)).length).toBe(256 * 1024);
  },
);

it.skipIf(process.platform !== "win32")(
  "falls back to read-only admission for closed read-only producer output",
  async () => {
    const target = await fixture();
    const open = vi.spyOn(fs, "open");
    await target.publish(async (file) => {
      await fs.writeFile(file, "read-only");
      await fs.chmod(file, 0o444);
    });
    const sourceCalls = open.mock.calls.filter(([file]) => String(file) === target.candidate());
    expect(sourceCalls.map(([, flags]) => flags)).toEqual([
      fsSync.constants.O_WRONLY,
      fsSync.constants.O_RDONLY,
    ]);
    expect(await fs.readFile(target.final, "utf8")).toBe("read-only");
  },
);

it.each([
  { code: "EACCES", syncTempFile: false, expected: fsSync.constants.O_RDONLY },
  { code: "EPERM", syncTempFile: false, expected: fsSync.constants.O_RDONLY },
  { code: "EBUSY", syncTempFile: false, expected: fsSync.constants.O_RDONLY },
  { code: "EACCES", syncTempFile: true, expected: fsSync.constants.O_RDWR },
])("falls back from a write-only $code denial before admission", async ({ code, syncTempFile, expected }) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const target = await fixture(syncTempFile);
  const realOpen = fs.open.bind(fs);
  const sourceFlags: number[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const [file, flags] = args;
    if (String(file) === target.candidate()) {
      sourceFlags.push(flags as number);
      if (flags === fsSync.constants.O_WRONLY) throw errno(code);
    }
    return await realOpen(...args);
  });
  await target.publish((file) => fs.writeFile(file, "new"));
  expect(sourceFlags).toEqual([fsSync.constants.O_WRONLY, expected]);
  expect(await fs.readFile(target.final, "utf8")).toBe("new");
});

it.each(["EACCES", "EPERM"])(
  "retains the provisional descriptor until provider-compatible admission completes after %s",
  async (metadataCode) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const target = await fixture();
  const realOpen = fs.open.bind(fs);
  const realFstat = fsSync.fstatSync.bind(fsSync);
  const realLstat = fsSync.lstatSync.bind(fsSync);
  let provisionalFd = -1;
  let provisionalClose: ReturnType<typeof vi.spyOn> | undefined;
  let provisionalClosed = false;
  let fallbackInspected = false;
  let sourceReadmitted = false;
  const parentsReadmitted = new Set<string>();
  let rejectedMetadata = false;
  const sourceFlags: number[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === target.candidate()) {
      sourceFlags.push(args[1] as number);
      if (args[1] === fsSync.constants.O_WRONLY) {
        provisionalFd = handle.fd;
        const close = handle.close.bind(handle);
        provisionalClose = vi.spyOn(handle, "close").mockImplementation(async () => {
          try {
            expect(fallbackInspected).toBe(true);
            expect(sourceReadmitted).toBe(true);
            expect(parentsReadmitted).toEqual(new Set([target.dir, path.dirname(target.candidate())]));
            expect(() => realFstat(provisionalFd, { bigint: true })).not.toThrow();
          } finally {
            await close();
            provisionalClosed = true;
          }
        });
      }
    }
    return handle;
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    if (!rejectedMetadata && args[0] === provisionalFd) {
      rejectedMetadata = true;
      throw errno(metadataCode);
    }
    const stat = realFstat(...args);
    if (rejectedMetadata && args[0] !== provisionalFd) {
      if (!provisionalClosed) {
        expect(() => realFstat(provisionalFd, { bigint: true })).not.toThrow();
      }
      fallbackInspected = true;
    }
    return stat;
  });
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = realLstat(...args);
    if (fallbackInspected) {
      const observed = String(args[0]);
      if (observed === target.candidate()) sourceReadmitted = true;
      if (observed === target.dir || observed === path.dirname(target.candidate())) {
        parentsReadmitted.add(observed);
      }
    }
    return stat;
  });

  await target.publish((file) => fs.writeFile(file, "new"));
  expect(rejectedMetadata).toBe(true);
  expect(sourceFlags).toEqual([fsSync.constants.O_WRONLY, fsSync.constants.O_RDONLY]);
  expect(provisionalClose).toHaveBeenCalledOnce();
  expect(await fs.readFile(target.final, "utf8")).toBe("new");
  },
);

it.each(["identity", "EIO", "EBUSY"] as const)(
  "does not fall back after a write-only descriptor %s failure",
  async (failure) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const target = await fixture();
    const realOpen = fs.open.bind(fs);
    const realFstat = fsSync.fstatSync.bind(fsSync);
    let provisionalFd = -1;
    const sourceFlags: number[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === target.candidate()) {
        sourceFlags.push(args[1] as number);
        provisionalFd = handle.fd;
      }
      return handle;
    });
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      const stat = realFstat(...args);
      if (args[0] !== provisionalFd) return stat;
      if (failure !== "identity") throw errno(failure);
      return Object.assign(stat, { ino: stat.ino + 1n });
    });

    const pending = target.publish((file) => fs.writeFile(file, "new"));
    if (failure !== "identity") await expect(pending).rejects.toMatchObject({ code: failure });
    else await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
    expect(sourceFlags).toEqual([fsSync.constants.O_WRONLY]);
    expect(await fs.readFile(target.final, "utf8")).toBe("old");
  },
);

it("aborts before linking when the provisional descriptor cannot close", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const target = await fixture();
  const realOpen = fs.open.bind(fs);
  const realFstat = fsSync.fstatSync.bind(fsSync);
  const closeFailure = new Error("provisional close failed");
  let provisionalFd = -1;
  let rejectedMetadata = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === target.candidate() && args[1] === fsSync.constants.O_WRONLY) {
      provisionalFd = handle.fd;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        throw closeFailure;
      });
    }
    return handle;
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    if (!rejectedMetadata && args[0] === provisionalFd) {
      rejectedMetadata = true;
      throw errno("EPERM");
    }
    return realFstat(...args);
  });
  const link = vi.spyOn(fsSync, "linkSync");

  await expect(target.publish((file) => fs.writeFile(file, "new"))).rejects.toBe(closeFailure);
  expect(link).not.toHaveBeenCalled();
  expect(await fs.readFile(target.final, "utf8")).toBe("old");
});

it("re-admits the source after closing a provisional descriptor", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const target = await fixture();
  const realOpen = fs.open.bind(fs);
  const realFstat = fsSync.fstatSync.bind(fsSync);
  let provisionalFd = -1;
  let rejectedMetadata = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === target.candidate() && args[1] === fsSync.constants.O_WRONLY) {
      provisionalFd = handle.fd;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        fsSync.renameSync(target.candidate(), `${target.candidate()}.original`);
        fsSync.writeFileSync(target.candidate(), "replacement");
      });
    }
    return handle;
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    if (!rejectedMetadata && args[0] === provisionalFd) {
      rejectedMetadata = true;
      throw errno("EPERM");
    }
    return realFstat(...args);
  });
  const link = vi.spyOn(fsSync, "linkSync");

  await expect(target.publish((file) => fs.writeFile(file, "new"))).rejects.toMatchObject({
    code: "path-mismatch",
  });
  expect(link).not.toHaveBeenCalled();
  expect(await fs.readFile(target.final, "utf8")).toBe("old");
});

it("aggregates fallback admission and both descriptor close failures before linking", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const target = await fixture();
  const realOpen = fs.open.bind(fs);
  const realFstat = fsSync.fstatSync.bind(fsSync);
  const admissionFailure = errno("EIO");
  const fallbackCloseFailure = new Error("fallback close failed");
  const provisionalCloseFailure = new Error("provisional close failed");
  let provisionalFd = -1;
  let fallbackFd = -1;
  let rejectedMetadata = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === target.candidate()) {
      const close = handle.close.bind(handle);
      if (args[1] === fsSync.constants.O_WRONLY) {
        provisionalFd = handle.fd;
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          throw provisionalCloseFailure;
        });
      } else {
        fallbackFd = handle.fd;
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          throw fallbackCloseFailure;
        });
      }
    }
    return handle;
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    if (!rejectedMetadata && args[0] === provisionalFd) {
      rejectedMetadata = true;
      throw errno("EPERM");
    }
    if (args[0] === fallbackFd) throw admissionFailure;
    return realFstat(...args);
  });
  const link = vi.spyOn(fsSync, "linkSync");

  const failure = await target.publish((file) => fs.writeFile(file, "new")).catch((error) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    admissionFailure,
    fallbackCloseFailure,
    provisionalCloseFailure,
  ]);
  expect(link).not.toHaveBeenCalled();
  expect(await fs.readFile(target.final, "utf8")).toBe("old");
});
