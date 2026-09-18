import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { root, type Root, type RootWriteOptions } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { windowsPolicyBinding } from "./helpers/windows-policy-binding.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let windowsBinding: NativeBinding | undefined;
if (process.platform === "win32") {
  try {
    windowsBinding = __loadBundledNativeForTest();
  } catch (error) {
    if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

const operations = ["write", "create", "stream", "copy"] as const;
type Operation = typeof operations[number];

async function runOperation(safe: Root, operation: Operation, source: string, options: RootWriteOptions) {
  const target = "one/two/value";
  if (operation === "write") await safe.write(target, "payload", options);
  else if (operation === "create") await safe.create(target, "payload", options);
  else if (operation === "copy") await safe.copyIn(target, source, options);
  else await safe.create(target, (async function* () { yield Buffer.from("payload"); })(), options);
}

async function fixture(bindingOverride?: NativeBinding) {
  const base = await tempRoot("fs-safe-root-native-windows-policy-");
  const rootPath = path.join(base, "root");
  const source = path.join(base, "source");
  await fs.mkdir(rootPath);
  await fs.writeFile(source, "payload");
  const native = windowsPolicyBinding(rootPath);
  __setNativeLoaderForTest(() => bindingOverride ?? native.binding);
  configureFsSafeNative({ mode: "require" });
  Object.defineProperty(process, "platform", { value: "win32" });
  return { ...native, rootPath, source, safe: await root(rootPath) };
}

it.each(operations.flatMap(operation => ["one", "one/two"].map(denied => ({ operation, denied }))))(
  "$operation rejects missing $denied before native creation",
  async ({ operation, denied }) => {
    const f = await fixture();
    await expect(runOperation(f.safe, operation, f.source, {
      denyMutations: { paths: [path.join(f.rootPath, denied)] }, durable: false,
    })).rejects.toMatchObject({ code: "denied-path" });
    expect(f.calls.openBeneath).toHaveBeenCalled();
    expect(f.calls.mkdirChildBeneath).toHaveBeenCalledTimes(denied === "one" ? 0 : 1);
    expect(f.calls.mkdirBeneath).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(f.rootPath, denied))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(denied === "one" ? f.rootPath : path.join(f.rootPath, "one"))).toEqual([]);
    expect(await fs.readFile(f.source, "utf8")).toBe("payload");
  },
);

it.each(operations.flatMap(operation => [true, false].map(mkdir => ({ operation, mkdir }))))(
  "$operation can use an exactly denied existing parent with mkdir=$mkdir",
  async ({ operation, mkdir }) => {
    const f = await fixture();
    const parent = path.join(f.rootPath, "one/two");
    await fs.mkdir(parent, { recursive: true });
    await runOperation(f.safe, operation, f.source, {
      denyMutations: { paths: [parent] }, durable: false, mkdir,
    });
    expect(f.calls.openBeneath).toHaveBeenCalled();
    expect(f.calls.mkdirChildBeneath).not.toHaveBeenCalled();
    expect(f.calls.mkdirBeneath).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(parent, "value"), "utf8")).toBe("payload");
    expect(await fs.readdir(parent)).toEqual(["value"]);
  },
);

it.each(operations)("%s does not create a missing parent with mkdir:false", async operation => {
  const f = await fixture();
  await expect(runOperation(f.safe, operation, f.source, {
    mutationSymlinks: "reject", mkdir: false, durable: false,
  })).rejects.toMatchObject({ code: "not-found" });
  expect(f.calls.mkdirChildBeneath).not.toHaveBeenCalled();
  expect(f.calls.mkdirBeneath).not.toHaveBeenCalled();
  expect(await fs.readdir(f.rootPath)).toEqual([]);
});

it.each(operations)("%s honors authority refusal before its first parent creation", async operation => {
  const f = await fixture();
  const refusal = new Error("authority revoked");
  await expect(runOperation(f.safe, operation, f.source, {
    mutationSymlinks: "reject", durable: false,
    assertBeforeMutation() { throw refusal; },
  })).rejects.toBe(refusal);
  expect(f.calls.mkdirChildBeneath).not.toHaveBeenCalled();
  expect(f.calls.mkdirBeneath).not.toHaveBeenCalled();
  expect(await fs.readdir(f.rootPath)).toEqual([]);
});

it.runIf(windowsBinding !== undefined).each(
  operations.flatMap(operation => ["one", "one/two"].map(denied => ({ operation, denied }))),
)("bundled Windows native $operation rejects missing $denied", async ({ operation, denied }) => {
  const f = await fixture(windowsBinding!);
  const deniedPath = path.join(f.rootPath, denied);
  await expect(runOperation(f.safe, operation, f.source, {
    denyMutations: { paths: [deniedPath] }, durable: false,
  })).rejects.toMatchObject({ code: "denied-path" });
  await expect(fs.lstat(deniedPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(denied === "one" ? f.rootPath : path.join(f.rootPath, "one"))).toEqual([]);
});
