import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDirectory, createDirectorySync, createFileHandle, createFileSync } from "../src/create.js";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { useTempDirs } from "./helpers/vitest.js";

const tempDirs = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function identity(stat: fs.BigIntStats): string {
  return `${stat.dev.toString(16).padStart(16, "0")}:${stat.ino.toString(16).padStart(32, "0")}`;
}

// Real filesystem identities stand in for the Windows wire representation;
// this fixture tests orchestration, while Windows bridge tests prove ACL facts.
const fileCapabilities = [
  "createPrivateDirectoryWithParentIdentity", "inspectWindowsDirectory",
  "protectPrivateWindowsFile", "verifyPrivateWindowsFile",
] as const;
type FileCapability = typeof fileCapabilities[number];

function useWindowsIdentityBackend(inspectStage?: () => void, missing: readonly FileCapability[] = []): void {
  const observed = (pathname: string) => identity(fs.lstatSync(pathname, { bigint: true }));
  const parentMatches = (pathname: string, expected: string) => {
    if (observed(path.dirname(pathname)) !== expected) throw new FsSafeError("path-mismatch", "parent changed");
  };
  Object.defineProperty(process, "platform", { value: "win32" });
  configureFsSafeNative({ mode: "require" });
  const binding = {
    closeOwnedFd: fs.closeSync,
    // Bun retains its POSIX host resolver while this fixture models Windows identity.
    canonicalizePath: (pathname: string) => ({ path: fs.realpathSync(pathname) }),
    inspectWindowsDirectory: (pathname: string) => {
      if (path.basename(pathname).startsWith(".fs-safe-create-")) inspectStage?.();
      return { identity: observed(pathname) };
    },
    createPrivateDirectoryWithParentIdentity: (pathname: string, parent: string) => {
      parentMatches(pathname, parent);
      fs.mkdirSync(pathname, { mode: 0o700 });
      return { identity: observed(pathname) };
    },
    protectPrivateWindowsFile: (fd: number, pathname: string, parent: string) => {
      parentMatches(pathname, parent);
      const held = identity(fs.fstatSync(fd, { bigint: true }));
      if (held !== observed(pathname)) throw new FsSafeError("path-mismatch", "file changed");
      return { identity: held };
    },
    verifyPrivateWindowsFile: (fd: number, pathname: string, expected: string, parent: string) => {
      parentMatches(pathname, parent);
      if (identity(fs.fstatSync(fd, { bigint: true })) !== expected || observed(pathname) !== expected) {
        throw new FsSafeError("path-mismatch", "file changed");
      }
    },
  } as NativeBinding;
  for (const capability of missing) delete binding[capability];
  __setNativeLoaderForTest(() => binding);
}

it.each(fileCapabilities.flatMap(missing =>
  (["root", "sync", "async"] as const).map(operation => ({ missing, operation }))))(
  "rejects required private $operation creation before mutation when $missing is unavailable",
  async ({ missing, operation }) => {
    const base = await tempDirs.tempRoot("fs-safe-private-capability-");
    const files = await root(base);
    useWindowsIdentityBackend(undefined, [missing]);
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const attempt = async () => {
      if (operation === "root") await files.create("absent/nested/value", "private", { private: true });
      else if (operation === "sync") createFileSync(path.join(base, "value"), { private: true }).close();
      else await (await createFileHandle(path.join(base, "value"), { private: true })).close();
    };
    const error: unknown = await attempt().catch(cause => cause);
    expect(mkdir).not.toHaveBeenCalled();
    expect(fs.readdirSync(base)).toEqual([]);
    expect(error).toMatchObject({ code: "helper-unavailable" });
  },
);

it("keeps directory-only creation available without private-file capabilities", async () => {
  const base = await tempDirs.tempRoot("fs-safe-private-directory-capability-");
  const files = await root(base);
  useWindowsIdentityBackend(undefined, ["protectPrivateWindowsFile", "verifyPrivateWindowsFile"]);
  createDirectorySync(path.join(base, "sync"), { private: true });
  await createDirectory(path.join(base, "async"), { private: true });
  await files.mkdir("parent/nested", { private: true });
  expect(fs.readdirSync(base).sort()).toEqual(["async", "parent", "sync"]);
  expect(fs.statSync(path.join(base, "parent/nested")).isDirectory()).toBe(true);
});

it("does not report an internal staging collision as an existing destination", async () => {
  const base = await tempDirs.tempRoot("fs-safe-created-collision-");
  const target = path.join(base, "requested");
  useWindowsIdentityBackend();
  const mkdir = fs.mkdirSync.bind(fs);
  vi.spyOn(fs, "mkdirSync").mockImplementation((pathname, options) => {
    if (String(pathname).includes(".fs-safe-create-")) {
      throw Object.assign(new Error("stage collision"), { code: "EEXIST" });
    }
    return mkdir(pathname, options);
  });
  expect(() => createFileSync(target, { private: true })).toThrow(expect.objectContaining({
    code: "helper-failed", details: expect.objectContaining({ publication: { status: "not-published" } }),
  }));
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.readdirSync(base)).toEqual([]);
});

it.each(["sync", "async"] as const)("records a preserved stage after settled %s directory adoption failure", async kind => {
  const base = await tempDirs.tempRoot("fs-safe-created-adoption-");
  const target = path.join(base, "requested");
  const failure = Object.assign(new Error("stage inspection failed"), { code: "EIO" });
  useWindowsIdentityBackend(() => { throw failure; });
  const operation = kind === "sync"
    ? async () => createFileSync(target, { private: true })
    : () => createFileHandle(target, { private: true });
  const error = await operation().catch(cause => cause);
  expect(fs.existsSync(target)).toBe(false);
  const [stageName, ...otherEntries] = fs.readdirSync(base);
  expect(stageName).toMatch(/^\.fs-safe-create-/);
  expect(otherEntries).toEqual([]);
  const stageDirectory = path.join(base, stageName!);
  expect(fs.readdirSync(stageDirectory)).toEqual([]);
  expect(error).toMatchObject({
    code: "helper-failed",
    details: { publication: { status: "not-published" }, path: target, stageDirectory, cleanup: "preserved" },
    cause: {
      code: "helper-failed",
      details: { publication: { status: "published" }, path: stageDirectory, cleanup: "preserved",
        windowsIdentity: identity(fs.lstatSync(stageDirectory, { bigint: true })) },
      cause: failure,
    },
  });
});

it.each(["authority", "chmod"] as const)("refuses a file replaced during final %s admission", async phase => {
  const base = await tempDirs.tempRoot("fs-safe-created-admission-");
  const target = path.join(base, "created");
  const moved = path.join(base, "original");
  useWindowsIdentityBackend();
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.renameSync(target, moved);
    fs.writeFileSync(target, "replacement");
  };
  if (phase === "chmod") {
    const open = fsAsync.open.bind(fsAsync);
    vi.spyOn(fsAsync, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const chmod = handle.chmod.bind(handle);
      vi.spyOn(handle, "chmod").mockImplementation(async mode => {
        await chmod(mode);
        replace();
      });
      return handle;
    });
  }
  let returned: Awaited<ReturnType<typeof createFileHandle>> | undefined;
  const operation = createFileHandle(target, {
    private: true,
    assertBeforeMutation: () => {
      if (phase === "authority" && fs.existsSync(target) &&
        fs.statSync(target).nlink === 1) replace();
    },
  }).then(handle => { returned = handle; return handle; });
  try {
    await expect(operation).rejects.toMatchObject({
      code: "helper-failed", details: { publication: { status: "published" }, cleanup: "removed" },
    });
    expect(replaced).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("replacement");
    expect(fs.statSync(moved).size).toBe(0);
    expect(fs.readdirSync(base).sort()).toEqual(["created", "original"]);
  } finally { await returned?.close(); }
});
