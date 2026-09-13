import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  Object.defineProperty(process, "platform", platform);
});

const routes = [
  { name: "fallback", mode: "off", windows: false },
  { name: "Windows fallback", mode: "off", windows: true },
  ...(nativeAvailable ? [{ name: "native", mode: "require", windows: false } as const] : []),
] as const;

async function fixture() {
  const directory = await tempRoot("fs-safe-root-authority-");
  await fs.writeFile(path.join(directory, "source"), "replacement");
  await fs.writeFile(path.join(directory, "target"), "original");
  return { directory, scoped: await root(directory) };
}

describe.each(routes)("Root mutation authority: $name", ({ mode, windows }) => {
  function configure() {
    configureFsSafeNative({ mode });
    if (windows) Object.defineProperty(process, "platform", { value: "win32" });
  }

  it.each(["write", "create", "copyIn"] as const)(
    "%s refuses publication after preparation loses authority and cleans its own files",
    async (operation) => {
      const { directory, scoped } = await fixture();
      if (operation === "copyIn") await fs.writeFile(path.join(directory, "source"), Buffer.alloc(256 * 1024, 1));
      configure();
      const target = operation === "create" ? "created" : "target";
      const expired = Object.assign(new Error("owner expired"), { code: "EEXIST" });
      let active = true;
      const assertBeforeMutation = () => {
        const createdTarget = operation === "create" && mode === "off" && fsSync.existsSync(path.join(directory, target));
        const preparedStage = fsSync.readdirSync(directory).some((name) =>
          name !== "source" && name !== "target" && fsSync.lstatSync(path.join(directory, name)).size > 0);
        if (createdTarget || preparedStage) active = false;
        if (!active) throw expired;
      };
      const pending = operation === "copyIn"
        ? scoped.copyIn(target, path.join(directory, "source"), { assertBeforeMutation })
        : scoped[operation](target, "replacement", { assertBeforeMutation });
      await expect(pending).rejects.toBe(expired);
      expect(active).toBe(false);
      expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("original");
      expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
    },
  );

  it.each(["short", "stalled"] as const)("preserves bytes and cleanup through %s writes", async (behavior) => {
    const { directory, scoped } = await fixture();
    configure();
    let writes = 0;
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation((async (buffer, offset, length, position) => {
        writes++;
        return behavior === "stalled" ? { bytesWritten: 0, buffer }
          : await write(buffer, offset, Math.min(length, 3), position);
      }) as typeof handle.write);
      return handle;
    });
    const write = fsSync.write.bind(fsSync);
    vi.spyOn(fsSync, "write").mockImplementation(((fd, buffer, offset, length, position, callback) => {
      writes++;
      if (behavior === "stalled") callback(null, 0, buffer);
      else write(fd, buffer, offset, Math.min(length, 3), position, callback);
    }) as typeof fsSync.write);
    const content = "é:🙂";
    const pending = scoped.write("target", content, { encoding: "utf16le" });
    if (behavior === "stalled") {
      await expect(pending).rejects.toMatchObject({ code: "helper-failed" });
      expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("original");
    } else {
      await pending;
      expect(await fs.readFile(path.join(directory, "target"))).toEqual(Buffer.from(content, "utf16le"));
    }
    expect(writes).toBeGreaterThan(0);
    expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
  });
});

it.each(["mkdir", "remove", "move"] as const)(
  "%s rechecks authority after awaited directory preparation",
  async (operation) => {
    const { directory, scoped } = await fixture();
    configureFsSafeNative({ mode: "off" });
    const expired = Object.assign(new Error("owner expired"), { code: "ENOENT" });
    let active = true;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (kind) => { if (kind === operation) active = false; },
    });
    const options = { assertBeforeMutation: () => { if (!active) throw expired; } };
    await expect(operation === "move"
      ? scoped.move("source", "target", { ...options, overwrite: true })
      : scoped[operation](operation === "mkdir" ? "new/nested" : "target", options)).rejects.toBe(expired);
    expect(active).toBe(false);
    expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("original");
    expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
  },
);

it.each([
  { method: "append", existing: true, closeFails: false },
  { method: "append", existing: false, closeFails: false },
  { method: "append", existing: true, closeFails: true },
  { method: "append", existing: false, closeFails: true },
  { method: "openWritable", existing: true, closeFails: false },
] as const)("$method refuses mutation after opening (existing=$existing, closeFails=$closeFails)", async ({ method, existing, closeFails }) => {
  const { directory, scoped } = await fixture();
  configureFsSafeNative({ mode: "off" });
  const relative = existing ? "target" : "new";
  const expired = new Error("owner expired");
  const closeFailure = new Error("descriptor close failed");
  let active = true;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === path.join(directory, relative)) {
      active = false;
      if (closeFails) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          throw closeFailure;
        });
      }
    }
    return handle;
  });
  const options = { assertBeforeMutation: () => { if (!active) throw expired; } };
  const pending = method === "append"
    ? scoped.append(relative, "replacement", options)
    : scoped.openWritable(relative, options);
  if (closeFails) {
    await expect(pending).rejects.toMatchObject({ error: closeFailure, suppressed: expired });
  } else {
    await expect(pending).rejects.toBe(expired);
  }
  expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("original");
  expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
});

it("composes root and call authority without overriding the root check", async () => {
  const { directory } = await fixture();
  configureFsSafeNative({ mode: "off" });
  const expired = new Error("root authority expired");
  let active = true;
  const calls: string[] = [];
  const scoped = await root(directory, {
    assertBeforeMutation: () => { calls.push("root"); if (!active) throw expired; },
  });
  const options = { assertBeforeMutation: () => calls.push("call") };
  await scoped.create("created", "ok", options);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((value, index) => value === (index % 2 === 0 ? "root" : "call"))).toBe(true);
  active = false;
  await expect(scoped.remove("created", options)).rejects.toBe(expired);
  expect(await fs.readFile(path.join(directory, "created"), "utf8")).toBe("ok");
});

it.each(["default", "call"])("rejects asynchronous %s authority before mutation", async (owner) => {
  const { directory } = await fixture();
  configureFsSafeNative({ mode: "off" });
  const options = { assertBeforeMutation: async () => { throw new Error("asynchronous refusal"); } };
  const scoped = await root(directory, owner === "default" ? options : {});
  await expect(scoped.remove("target", owner === "call" ? options : {})).rejects.toThrow("must be synchronous");
  expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("original");
});

it("settles final permissions and durability after an admitted publication", async () => {
  const { directory, scoped } = await fixture();
  configureFsSafeNative({ mode: "off" });
  const rename = fs.rename.bind(fs);
  let active = true;
  vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    await rename(...args);
    active = false;
  });
  await scoped.write("target", "replacement", {
    mode: 0o400,
    assertBeforeMutation: () => { if (!active) throw new Error("owner expired after publication"); },
  });
  expect(active).toBe(false);
  expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("replacement");
  if (process.platform !== "win32") expect((await fs.stat(path.join(directory, "target"))).mode & 0o777).toBe(0o400);
});

it.skipIf(!nativeAvailable || process.platform === "win32")("preserves native cleanup ownership evidence when authority expires after a stage replacement", async () => {
  const { directory, scoped } = await fixture();
  await fs.writeFile(path.join(directory, "source"), Buffer.alloc(256 * 1024, 1));
  configureFsSafeNative({ mode: "require" });
  let active = true;
  let temporaryName: string | undefined;
  const expired = new Error("owner expired");
  await expect(scoped.copyIn("target", path.join(directory, "source"), {
    assertBeforeMutation: () => {
      temporaryName = fsSync.readdirSync(directory).find((name) =>
        name !== "source" && name !== "target" && fsSync.lstatSync(path.join(directory, name)).size > 0);
      if (active && temporaryName) {
        fsSync.renameSync(path.join(directory, temporaryName), path.join(directory, "saved-stage"));
        fsSync.writeFileSync(path.join(directory, temporaryName), "replacement-owned-by-another-operation");
        active = false;
      }
      if (!active) throw expired;
    },
  })).rejects.toMatchObject({
    details: { phase: "prepare", cleanup: { status: "preserved", resources: "closed" } },
    cause: { cause: expired },
  });
  expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("original");
  expect(await fs.readFile(path.join(directory, temporaryName!), "utf8")).toBe("replacement-owned-by-another-operation");
});
