import { afterEach, expect, it, vi } from "vitest";
import {
  inspectCreationDirectory, inspectCreationDirectorySync,
  protectCreatedFile, protectCreatedFileSync,
  verifyCreatedFile, verifyCreatedFileSync,
} from "../src/creation-permissions.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import * as command from "../src/windows-security-command.js";

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

const operations = [
  {
    name: "inspectWindowsDirectory",
    args: ["/synthetic/parent", true],
    result: { identity: "parent" },
    returned: "parent",
    async: () => inspectCreationDirectory("/synthetic/parent", true),
    sync: () => inspectCreationDirectorySync("/synthetic/parent", true),
  },
  {
    name: "protectPrivateWindowsFile",
    args: [43, "/synthetic/file", "parent"],
    result: { identity: "file" },
    returned: "file",
    async: () => protectCreatedFile(43, "/synthetic/file", "parent"),
    sync: () => protectCreatedFileSync(43, "/synthetic/file", "parent"),
  },
  {
    name: "verifyPrivateWindowsFile",
    args: [43, "/synthetic/file", "file", "parent", 2],
    result: undefined,
    returned: undefined,
    async: () => verifyCreatedFile(43, "/synthetic/file", "file", "parent", 2),
    sync: () => verifyCreatedFileSync(43, "/synthetic/file", "file", "parent", 2),
  },
] as const;
const cases = operations.flatMap(operation => (["sync", "async"] as const).map(variant => ({ operation, variant })));

function forbidCommandFallback() {
  return ([
    "inspectWindowsDirectoryCommand", "inspectWindowsDirectoryCommandSync",
    "protectPrivateWindowsFileCommand", "protectPrivateWindowsFileCommandSync",
    "verifyPrivateWindowsFileCommand", "verifyPrivateWindowsFileCommandSync",
  ] as const).map(name => vi.spyOn(command, name).mockImplementation(() => {
    throw new Error("an available native operation must not fall back to a command");
  }));
}

it.each(cases)("keeps the native receiver and arguments for $operation.name ($variant)", async ({ operation, variant }) => {
  const fallback = forbidCommandFallback();
  configureFsSafeNative({ mode: "auto" });
  const binding = {
    closeOwnedFd: vi.fn(),
    [operation.name]: function (this: NativeBinding, ...args: unknown[]) {
      expect(this).toBe(binding);
      expect(args).toEqual(operation.args);
      return operation.result;
    },
  } as unknown as NativeBinding;
  __setNativeLoaderForTest(() => binding);
  expect(await operation[variant]()).toBe(operation.returned);
  for (const attempt of fallback) expect(attempt).not.toHaveBeenCalled();
});

it.each(cases)("preserves a native thrown undefined for $operation.name ($variant)", async ({ operation, variant }) => {
  const fallback = forbidCommandFallback();
  configureFsSafeNative({ mode: "auto" });
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: vi.fn(),
    [operation.name]: () => { throw undefined; },
  }) as unknown as NativeBinding);
  await expect((async () => await operation[variant]())()).rejects.toBeUndefined();
  for (const attempt of fallback) expect(attempt).not.toHaveBeenCalled();
});
