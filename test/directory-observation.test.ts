import fsSync, { type BigIntStats, type Stats } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDirectoryObservationGuardSync,
  extendDirectoryObservationGuard,
  inspectDirectoryObservationSync,
} from "../src/directory-guard.js";
import { realpathSync } from "../src/realpath.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const numeric = () => ({ dev: 7, ino: 11, isDirectory: () => true, isSymbolicLink: () => false }) as Stats;
const exact = () => ({ dev: 7n, ino: 11n, isDirectory: () => true, isSymbolicLink: () => false }) as BigIntStats;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

it("extends an operation-owned observation into its directory guard", () => {
  const observation = { stat: numeric(), identity: { dev: 7n, ino: 11n } };
  const guard = extendDirectoryObservationGuard(observation, "/root/selected", "/root/selected");
  expect(guard).toBe(observation);
  expect(guard).toMatchObject({ dir: "/root/selected", realPath: "/root/selected" });
});

it.each([
  { platform: "linux", input: "/root/selected///", expected: "/root/selected" },
  { platform: "linux", input: "/root/alias/../selected///", expected: "/root/alias/../selected" },
  { platform: "linux", input: "/root/literal\\///", expected: "/root/literal\\" },
  { platform: "linux", input: "///", expected: "///" },
  { platform: "win32", input: "C:\\root\\selected\\\\", expected: "C:\\root\\selected" },
  { platform: "win32", input: "C:\\\\", expected: "C:\\\\" },
  { platform: "win32", input: "\\\\server\\share\\\\", expected: "\\\\server\\share\\\\" },
  { platform: "win32", input: "\\\\?\\UNC\\server\\share\\\\", expected: "\\\\?\\UNC\\server\\share\\\\" },
])("preserves $platform directory spelling $input", ({ platform: projected, input, expected }) => {
  Object.defineProperty(process, "platform", { value: projected });
  const lstat = vi.spyOn(fsSync, "lstatSync").mockReturnValue(projected === "win32" ? exact() : numeric());
  expect(inspectDirectoryObservationSync(input).identity).toEqual({ dev: 7n, ino: 11n });
  expect(lstat.mock.calls).toEqual(projected === "win32" ? [[expected, { bigint: true }]] : [[expected]]);
});

describe.each(["linux", "win32"] as const)("%s guarded directory receipt", projected => {
  it.each(["symlink", "non-directory"])("rejects %s before an identity failure", kind => {
    Object.defineProperty(process, "platform", { value: projected });
    const stat = projected === "win32" ? exact() : numeric();
    const lstat = vi.spyOn(fsSync, "lstatSync").mockReturnValue({
      ...stat,
      dev: projected === "win32" ? 0n : NaN,
      isDirectory: () => kind !== "non-directory",
      isSymbolicLink: () => kind === "symlink",
    } as Stats | BigIntStats);
    expect(() => inspectDirectoryObservationSync("/root/selected///", { dev: 7n, ino: 11n }))
      .toThrow(expect.objectContaining({ code: "not-file" }));
    expect(lstat).toHaveBeenCalledTimes(1);
  });

  it("revalidates directory type on promotion or Windows retry", () => {
    Object.defineProperty(process, "platform", { value: projected });
    const initial = projected === "win32" ? { ...exact(), ino: 0n } : { ...numeric(), ino: NaN };
    const lstat = vi.spyOn(fsSync, "lstatSync")
      .mockReturnValueOnce(initial)
      .mockReturnValue({ ...exact(), isSymbolicLink: () => true });
    expect(() => inspectDirectoryObservationSync("/root/selected", { dev: 7n, ino: 11n }))
      .toThrow(expect.objectContaining({ code: "not-file" }));
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(lstat.mock.calls[1]).toEqual(["/root/selected", { bigint: true }]);
  });

  it("checks exact identity before canonical admission", () => {
    Object.defineProperty(process, "platform", { value: projected });
    const events: string[] = [];
    vi.spyOn(fsSync, "lstatSync").mockImplementation(() => {
      events.push("identity");
      return projected === "win32" ? exact() : numeric();
    });
    vi.spyOn(realpathSync, "native").mockImplementation(() => {
      events.push("canonical");
      return "/root/changed";
    });
    expect(() => assertDirectoryObservationGuardSync({
      dir: "/root/selected", realPath: "/root/selected", stat: exact(), identity: { dev: 7n, ino: 11n },
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(events).toEqual(["identity", "canonical"]);
  });
});
