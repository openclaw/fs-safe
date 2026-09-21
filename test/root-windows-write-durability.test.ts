import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import * as durability from "../src/directory-durability.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
});

async function fixture(defaultDurable?: boolean) {
  const dir = await tempRoot("fs-safe-windows-write-durable-");
  Object.defineProperty(process, "platform", { value: "win32" });
  configureFsSafeNative({ mode: "off" });
  const scoped = await root(dir, { durable: defaultDurable });
  return { dir, scoped, target: path.join(dir, "target") };
}

const operations = ["write", "replace", "create", "exclusive", "writeJson", "createJson"] as const;
const settings = [
  { label: "default", enabled: true },
  { label: "disabled default", root: false, enabled: false },
  { label: "disabled call", call: false, enabled: false },
  { label: "enabled override", root: false, call: true, enabled: true },
  { label: "disabled override", root: true, call: false, enabled: false },
];

it.each([false, true])("keeps the destination old or absent while buffering (existing=%s)", async existing => {
  const { scoped, target } = await fixture(false);
  if (existing) await fs.writeFile(target, "original");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (path.basename(String(args[0])).startsWith(".fs-safe-")) {
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
        entered.resolve();
        await resume.promise;
        return await write(...writeArgs);
      });
    }
    return handle;
  });
  const pending = scoped.write("target", Buffer.from("complete replacement"));
  try {
    await entered.promise;
    if (existing) expect(await fs.readFile(target, "utf8")).toBe("original");
    else await expect(fs.readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    resume.resolve();
    await pending;
  }
  expect(await fs.readFile(target, "utf8")).toBe("complete replacement");
});

it.each(operations.flatMap(operation => settings.map(setting => ({ operation, ...setting }))))(
  "$operation honors $label durability through Windows fallback dispatch",
  async ({ operation, enabled, root: defaultDurable, call }) => {
    const { dir, scoped, target } = await fixture(defaultDurable);
    if (operation === "replace") await fs.writeFile(target, "original");
    const events: string[] = [];
    const destinationHandles: fs.FileHandle[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === target) destinationHandles.push(handle);
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
        events.push("write");
        return await write(...writeArgs);
      });
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { events.push("sync"); await sync(); });
      const chmod = handle.chmod.bind(handle);
      vi.spyOn(handle, "chmod").mockImplementation(async mode => { events.push("chmod"); await chmod(mode); });
      return handle;
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      expect(destinationHandles.every(handle => handle.fd === -1)).toBe(true);
      events.push("rename");
      await rename(...args);
    });
    const parentSync = vi.spyOn(durability, "syncDirectoryBestEffort").mockImplementation(async () => {
      events.push("directory");
    });
    const options = { durable: call };
    if (operation === "writeJson" || operation === "createJson") await scoped[operation]("target", { value: 1 }, options);
    else if (operation === "create") await scoped.create("target", "new bytes", options);
    else await scoped.write("target", "new bytes", { ...options, overwrite: operation !== "exclusive" });
    const replacing = ["write", "replace", "writeJson"].includes(operation);
    const expected = replacing
      ? ["write", "sync", "rename", "chmod", "sync", "directory"]
      : ["write", "sync", "directory"];
    expect(events).toEqual(enabled ? expected : expected.filter(event => event !== "sync" && event !== "directory"));
    expect(parentSync).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) expect(parentSync).toHaveBeenCalledWith(dir);
    expect(await fs.readFile(target, "utf8")).toBe(operation.endsWith("Json") ? '{"value":1}\n' : "new bytes");
  },
);

it.each(["write", "replace", "create"] as const)("%s reports file sync failure and cleans only the owned new file with a large parent inode", async operation => {
  const { dir, target } = await fixture();
  if (operation === "replace") await fs.writeFile(target, "original");
  for (const method of ["statSync", "lstatSync"] as const) {
    const original = fsSync[method].bind(fsSync);
    vi.spyOn(fsSync, method).mockImplementation((...args) => {
      const stat = original(...args);
      if (String(args[0]) === dir && typeof stat.ino === "bigint") {
        return Object.assign(Object.create(stat), { ino: 9007199254740993n });
      }
      return stat;
    });
  }
  const scoped = await root(dir);
  const error = Object.assign(new Error("sync failed"), { code: "EIO" });
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    vi.spyOn(handle, "sync").mockRejectedValue(error);
    return handle;
  });
  await expect(scoped[operation === "replace" ? "write" : operation]("target", "new bytes")).rejects.toBe(error);
  expect(await fs.readdir(dir)).toEqual(operation === "replace" ? ["target"] : []);
  if (operation === "replace") expect(await fs.readFile(target, "utf8")).toBe("original");
});

it.each(["write failure", "sync failure", "successful sync"] as const)(
  "preserves a staging replacement after %s",
  async fault => {
    const { dir, scoped, target } = await fixture();
    await fs.writeFile(target, "original");
    const moved = path.join(dir, "displaced");
    let stagingPath!: string;
    let opened: fs.FileHandle | undefined;
    const error = Object.assign(new Error("injected failure"), { code: "EIO" });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const pathname = String(args[0]);
      if (!path.basename(pathname).startsWith(".fs-safe-")) return handle;
      stagingPath = pathname;
      opened = handle;
      const swap = async () => {
        await fs.rename(pathname, moved);
        await fs.writeFile(pathname, "unowned replacement");
        if (fault !== "successful sync") throw error;
      };
      if (fault === "write failure") {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
          const result = await write(...writeArgs);
          await swap();
          return result;
        });
      } else {
        vi.spyOn(handle, "sync").mockImplementation(swap);
      }
      return handle;
    });
    const result = scoped.write("target", "new bytes");
    if (fault === "successful sync") await expect(result).rejects.toMatchObject({ code: "path-mismatch" });
    else await expect(result).rejects.toBe(error);
    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect(await fs.readFile(stagingPath, "utf8")).toBe("unowned replacement");
    expect((await fs.stat(moved)).isFile()).toBe(true);
    expect(opened?.fd).toBe(-1);
  },
);

it("preserves a destination created by another writer after staging sync failure", async () => {
  const { dir, scoped, target } = await fixture();
  const error = Object.assign(new Error("sync failed"), { code: "EIO" });
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (path.basename(String(args[0])).startsWith(".fs-safe-")) {
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        await fs.writeFile(target, "unowned destination", { flag: "wx" });
        throw error;
      });
    }
    return handle;
  });
  await expect(scoped.write("target", "new bytes")).rejects.toBe(error);
  expect(await fs.readFile(target, "utf8")).toBe("unowned destination");
  expect(await fs.readdir(dir)).toEqual(["target"]);
});

it.skipIf(platform.value === "win32").each([
  { mode: undefined, expectedMode: 0o400 },
  { mode: 0o660, expectedMode: 0o660 },
])("preserves masked new-file mode unless explicitly overridden ($mode)", async ({ mode, expectedMode }) => {
  const { scoped, target } = await fixture(false);
  const previous = process.umask(0o277);
  try {
    await scoped.write("target", Buffer.from("complete"), { mode });
    expect((await fs.stat(target)).mode & 0o777).toBe(expectedMode);
    expect(await fs.readFile(target, "utf8")).toBe("complete");
  } finally {
    process.umask(previous);
  }
});

it.each(["regular", "write-only", "read-only", "hardlink", "directory"] as const)(
  "readmits a raced %s destination with wider write options",
  async kind => {
    const { dir, scoped, target } = await fixture(false);
    const sentinel = path.join(dir, "sentinel");
    await fs.writeFile(sentinel, "unowned");
    const open = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])).startsWith(".fs-safe-")) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
          const result = await write(...writeArgs);
          if (!injected) {
            injected = true;
            await fs.rm(target, { force: true });
            if (kind === "regular" || kind === "write-only" || kind === "read-only") {
              await fs.writeFile(target, "raced ordinary file", {
                mode: kind === "read-only" ? 0o400 : kind === "write-only" ? 0o200 : 0o600,
              });
            }
            else if (kind === "hardlink") await fs.link(sentinel, target);
            else await fs.mkdir(target);
          }
          return result;
        });
      }
      return handle;
    });
    const rename = fs.rename.bind(fs);
    let publications = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === target) publications++;
      await rename(...args);
    });
    const options = { durable: false, append: true };
    const pending = scoped.write("target", Buffer.from("complete"), options);
    if (kind === "regular" || kind === "write-only") {
      await pending;
      expect(await fs.readFile(target, "utf8")).toBe("complete");
    } else if (kind === "read-only") {
      await expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^(?:EACCES|EPERM)$/) });
      expect(await fs.readFile(target, "utf8")).toBe("raced ordinary file");
      await fs.chmod(target, 0o600);
    } else {
      await expect(pending).rejects.toMatchObject({ code: kind === "hardlink" ? "hardlink" : "path-mismatch" });
    }
    expect(injected).toBe(true);
    expect(publications).toBe(kind === "regular" || kind === "write-only" ? 1 : 0);
    expect(await fs.readFile(sentinel, "utf8")).toBe("unowned");
  },
);

it.each([undefined, "reject"] as const)("rejects a final junction inserted by the last authority callback (%s)", async mutationSymlinks => {
  const { scoped, target } = await fixture(false);
  const outside = await tempRoot("fs-safe-windows-write-outside-");
  const sentinel = path.join(outside, "sentinel");
  await fs.writeFile(sentinel, "unowned");
  const open = fs.open.bind(fs);
  let written = false;
  let injected = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (path.basename(String(args[0])).startsWith(".fs-safe-")) {
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
        const result = await write(...writeArgs);
        written = true;
        return result;
      });
    }
    return handle;
  });
  const rename = fs.rename.bind(fs);
  let publications = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    if (String(args[1]) === target) publications++;
    await rename(...args);
  });
  await expect(scoped.write("target", Buffer.from("complete"), {
    mutationSymlinks,
    assertBeforeMutation: () => {
      if (written && !injected) {
        injected = true;
        fsSync.rmSync(target, { force: true });
        fsSync.symlinkSync(outside, target, "junction");
      }
    },
  })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(injected).toBe(true);
  expect(publications).toBe(0);
  expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(sentinel, "utf8")).toBe("unowned");
});
