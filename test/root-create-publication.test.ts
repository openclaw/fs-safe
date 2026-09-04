import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

const operations = ["create", "write", "createJson", "writeJson"] as const;
const outcomes = ["success", "write-error", "competing-create"] as const;

async function runOperation(
  capability: Awaited<ReturnType<typeof root>>,
  operation: (typeof operations)[number],
  content: string,
) {
  if (operation === "create") return capability.create("target", content);
  if (operation === "write") return capability.write("target", content, { overwrite: false });
  if (operation === "createJson") {
    return capability.createJson("target", JSON.parse(content), { space: 0, trailingNewline: false });
  }
  return capability.writeJson("target", JSON.parse(content), { overwrite: false, space: 0, trailingNewline: false });
}

describe("create-only publication outcomes", () => {
  it.each(operations.flatMap((operation) => outcomes.map((outcome) => ({ operation, outcome }))))(
    "$operation keeps the winner through $outcome (native off)",
    async ({ operation, outcome }) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-create-publication-");
      const capability = await root(directory);
      const target = path.join(capability.rootReal, "target");
      const content = operation.endsWith("Json") ? '{"value":"complete"}' : "complete";
      const failure = Object.assign(new Error("synthetic content failure"), { code: "EIO" });
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (!(await handle.stat()).isFile()) return handle;
        if (String(args[0]) !== target) return handle;
        const writeFile = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
          if (outcome === "write-error") {
            await writeFile("partial");
            throw failure;
          }
          await writeFile(...writeArgs);
          if (outcome === "competing-create") return; // target already exists; never reached
        });
        return handle;
      });
      if (outcome === "competing-create") await fs.writeFile(target, "winner", { mode: 0o600 });

      const pending = runOperation(capability, operation, content);
      if (outcome === "write-error") {
        await expect(pending).rejects.toBeTruthy();
        await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      } else if (outcome === "competing-create") {
        await expect(pending).rejects.toMatchObject({ code: "already-exists" });
        expect(await fs.readFile(target, "utf8")).toBe("winner");
      } else {
        await expect(pending).resolves.toBeUndefined();
        expect(await fs.readFile(target, "utf8")).toBe(content);
        expect((await fs.stat(target)).nlink).toBe(1);
      }
    },
  );
});

describe("create-only publication visibility", () => {
  // The fallback claims the final name with O_EXCL before writing. This pins
  // the documented limitation so a future backend change is deliberate.
  it.each(operations)("%s claims the final name before content in native-off mode", async (operation) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-create-visible-off-");
    const capability = await root(directory);
    const target = path.join(capability.rootReal, "target");
    const content = operation.endsWith("Json") ? '{"value":"complete"}' : "complete";
    let visibleBeforeWrite: boolean | undefined;
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) !== target || !(await handle.stat()).isFile()) return handle;
      const writeFile = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
        visibleBeforeWrite = await fs.lstat(target).then(
          (stat) => stat.isFile() && stat.size === 0,
          () => false,
        );
        await writeFile(...writeArgs);
      });
      return handle;
    });

    await runOperation(capability, operation, content);
    expect(visibleBeforeWrite).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe(content);
  });

  // The native backend stages privately and publishes with a no-replace
  // rename, so the destination must not exist until the content is complete.
  it.skipIf(!nativeAvailable).each(operations)(
    "%s keeps the destination absent until publication in require mode",
    async (operation) => {
      configureFsSafeNative({ mode: "require" });
      const directory = await tempRoot("fs-safe-create-visible-native-");
      const capability = await root(directory);
      const target = path.join(capability.rootReal, "target");
      const content = operation.endsWith("Json") ? '{"value":"complete"}' : "complete";
      let visibleBeforeWrite: boolean | undefined;
      const writeSync = fsSync.writeSync.bind(fsSync);
      vi.spyOn(fsSync, "writeSync").mockImplementation((fd, buffer, ...rest) => {
        if (visibleBeforeWrite === undefined && fsSync.fstatSync(fd).isFile()) {
          visibleBeforeWrite = fsSync.existsSync(target);
        }
        return writeSync(fd, buffer, ...rest as []);
      });

      await runOperation(capability, operation, content);
      expect(visibleBeforeWrite).toBe(false);
      expect(await fs.readFile(target, "utf8")).toBe(content);
    },
  );
});
