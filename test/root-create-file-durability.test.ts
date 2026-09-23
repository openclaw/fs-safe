import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { createSecretFileAtomic } from "../src/secret.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  nativeAvailable = Boolean(__loadBundledNativeForTest());
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function* content() {
  yield Buffer.from("complete");
}

type Input = "buffer" | "stream" | "json" | "atomic-buffer" | "atomic-json" | "secret";

function create(
  scoped: Awaited<ReturnType<typeof root>>,
  input: Input,
  options: { durable: boolean | "file"; mode?: number },
) {
  if (input === "secret") return createSecretFileAtomic({
    rootDir: scoped.rootReal,
    filePath: path.join(scoped.rootReal, "target"),
    content: "complete",
    ...options,
  });
  if (input === "stream") return scoped.create("target", content(), options);
  const createOptions = { ...options, ...(input.startsWith("atomic-") ? { atomic: true } : {}) };
  return input.endsWith("json")
    ? scoped.createJson("target", { complete: true }, createOptions)
    : scoped.create("target", Buffer.from("complete"), createOptions);
}

async function expectCompleteTarget(directory: string, input: Input) {
  const target = path.join(directory, "target");
  const bytes = await fs.readFile(target, "utf8");
  expect(input.endsWith("json") ? JSON.parse(bytes) : bytes).toEqual(
    input.endsWith("json") ? { complete: true } : "complete",
  );
  expect((await fs.stat(target)).nlink).toBe(1);
  expect(await fs.readdir(directory)).toEqual(["target"]);
}

function failSync(kind: "file" | "directory", failure: Error, beforeFailure?: () => void) {
  const matches = (fd: number) => kind === "file"
    ? fsSync.fstatSync(fd).isFile() : fsSync.fstatSync(fd).isDirectory();
  const sync = fsSync.fsyncSync;
  vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
    if (matches(fd)) { beforeFailure?.(); throw failure; }
    sync(fd);
  });
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      if (matches(handle.fd)) { beforeFailure?.(); throw failure; }
      await sync();
    });
    return handle;
  });
}

for (const native of [false, true]) {
  describe.skipIf(native && !nativeAvailable)(`create file durability (native=${native})`, () => {
    it.each(["buffer", "stream", "json", "atomic-buffer", "atomic-json", "secret"] as const)(
      "%s rejects a required file flush without leaving an owned creation",
      async input => {
        configureFsSafeNative({ mode: native ? "require" : "off" });
        const directory = await tempRoot("fs-safe-create-required-sync-");
        const scoped = await root(directory, { durable: false });
        const failure = Object.assign(new Error("file flush denied"), { code: "EPERM" });
        failSync("file", failure, input.startsWith("atomic-") ? () => {
          expect(fsSync.existsSync(path.join(directory, "target"))).toBe(false);
        } : undefined);
        const pending = create(scoped, input, { durable: "file" });
        await expect(pending).rejects.toSatisfy((error: Error) => error === failure || error.cause === failure);
        expect(await fs.readdir(directory)).toEqual([]);
      },
    );

    it.each(["stream", "atomic-buffer", "atomic-json", "secret"] as const)("%s preserves boolean durability's EPERM compatibility", async input => {
      configureFsSafeNative({ mode: native ? "require" : "off" });
      const directory = await tempRoot("fs-safe-create-compatible-sync-");
      const scoped = await root(directory);
      failSync("file", Object.assign(new Error("file flush denied"), { code: "EPERM" }));
      await create(scoped, input, { durable: true });
      await expectCompleteTarget(directory, input);
    });

    it.each(["atomic-buffer", "atomic-json", "secret"] as const)("%s skips file synchronization with durable false", async input => {
      configureFsSafeNative({ mode: native ? "require" : "off" });
      const directory = await tempRoot("fs-safe-create-disabled-sync-");
      const scoped = await root(directory);
      failSync("file", Object.assign(new Error("file synchronization must be disabled"), { code: "EIO" }));
      await create(scoped, input, { durable: false });
      await expectCompleteTarget(directory, input);
    });

    it.each(["stream", "atomic-buffer", "atomic-json", "secret"] as const)("%s keeps directory synchronization best effort when the file flush is required", async input => {
      configureFsSafeNative({ mode: native ? "require" : "off" });
      const directory = await tempRoot("fs-safe-create-directory-sync-");
      const scoped = await root(directory);
      failSync("directory", Object.assign(new Error("directory flush unsupported"), { code: "EPERM" }));
      await create(scoped, input, { mode: 0o400, durable: "file" });
      await expectCompleteTarget(directory, input);
    });
  });
}

it.skipIf(!nativeAvailable).each(["stream", "atomic-buffer", "atomic-json"] as const)("preserves a published %s when its required final-mode flush fails", async input => {
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("fs-safe-create-published-sync-");
  const scoped = await root(directory);
  const failure = Object.assign(new Error("final mode flush denied"), { code: "EPERM" });
  const sync = fsSync.fsyncSync;
  vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
    if (fsSync.fstatSync(fd).isFile() && fsSync.existsSync(path.join(directory, "target"))) throw failure;
    sync(fd);
  });
  await expect(create(scoped, input, { mode: 0o400, durable: "file" })).rejects.toMatchObject({
    cause: failure,
    details: { publication: { status: "published", basename: "target" } },
  });
  await expectCompleteTarget(directory, input);
});
