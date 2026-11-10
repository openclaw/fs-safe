import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useRealTempDirs } from "./helpers/vitest.js";

const { probe } = vi.hoisted(() => ({ probe: vi.fn((_fd: number) => false) }));
vi.mock("../src/native.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/native.js")>(),
  getNativeBinding: () => ({ is9pFilesystem: probe }),
}));
const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function needsProbe(directory: string): boolean {
  const { dev } = fs.statSync(directory, { bigint: true });
  return ((dev >> 8n) & 0xfffn) === 0n && ((dev >> 32n) & 0xfffff000n) === 0n;
}
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); });

for (const sync of [false, true]) {
  it.skipIf(process.platform === "win32")(`skips non-9p recovery preparation after the first ${sync ? "sync" : "async"} write`, async () => {
    vi.resetModules();
    probe.mockReset().mockImplementation(fd => {
      expect(fs.fstatSync(fd).isDirectory()).toBe(true);
      return false;
    });
    Object.defineProperty(process, "platform", { value: "linux" });
    const { replaceFileAtomic, replaceFileAtomicSync } = await import("../src/atomic.js");
    const directory = await tempRoot("drvfs-preparation-");
    const write = (allowDrvfsRenameRecovery: boolean) => (sync ? replaceFileAtomicSync : replaceFileAtomic)({
      filePath: path.join(directory, "target"), content: "payload", allowDrvfsRenameRecovery,
    });
    await write(true);
    const open = vi.spyOn(fs, "openSync");
    const stat = vi.spyOn(fs, "fstatSync");
    const lstat = vi.spyOn(fs, "lstatSync");
    const counts = () => [open.mock.calls.length, stat.mock.calls.length, lstat.mock.calls.length];
    await write(false);
    const off = counts();
    open.mockClear(); stat.mockClear(); lstat.mockClear();
    await write(true);
    expect(counts()).toEqual(off);
    expect(probe).toHaveBeenCalledTimes(needsProbe(directory) ? 1 : 0);
  });
}

it("uses only negative filesystem observations and preserves unknown/9p candidates", async () => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "linux" });
  const { mayPrepareDrvfsRecoveryAtFd, shouldPrepareDrvfsRecovery } = await import("../src/publication-recovery.js");
  probe.mockReset().mockReturnValue(true);
  expect(mayPrepareDrvfsRecoveryAtFd(42, 9n)).toBe(true);
  expect(mayPrepareDrvfsRecoveryAtFd(42, 9n)).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
  probe.mockImplementationOnce(() => { throw new Error("unavailable"); });
  expect(mayPrepareDrvfsRecoveryAtFd(42, 10n)).toBe(true);
  expect(mayPrepareDrvfsRecoveryAtFd(42, 10n)).toBe(true);
  probe.mockReturnValue(false);
  expect(mayPrepareDrvfsRecoveryAtFd(42, 11n)).toBe(false);
  probe.mockClear();
  expect(mayPrepareDrvfsRecoveryAtFd(43, 11n)).toBe(false);
  expect(probe).not.toHaveBeenCalled();
  // Major-zero anonymous devices can have minor bits above bit 31.
  expect(shouldPrepareDrvfsRecovery(true, 1n << 32n)).toBe(true);
  expect(shouldPrepareDrvfsRecovery(true, 1n << 8n)).toBe(false);
  expect(shouldPrepareDrvfsRecovery(true, 1n << 44n)).toBe(false);
});

it.skipIf(process.platform === "win32")("checks a positive parent candidate only once per atomic write", async () => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "linux" });
  probe.mockReset().mockReturnValue(true);
  const { replaceFileAtomic } = await import("../src/atomic.js");
  const directory = await tempRoot("drvfs-candidate-");
  for (let i = 0; i < 2; i++) {
    await replaceFileAtomic({ filePath: path.join(directory, "target"), content: "payload", allowDrvfsRenameRecovery: true });
  }
  expect(probe).toHaveBeenCalledTimes(needsProbe(directory) ? 2 : 0);
});

for (const writer of ["json", "callback"] as const) {
  it.skipIf(process.platform === "win32")(`reuses the negative observation for ${writer} writers without an existing parent fd`, async () => {
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: "linux" });
    probe.mockReset().mockImplementation(fd => {
      expect(fs.fstatSync(fd).isDirectory()).toBe(true);
      return false;
    });
    const directory = await tempRoot("drvfs-no-parent-");
    const { writeJsonSync } = await import("../src/json.js");
    const { writeCallbackSibling } = await import("../src/sibling-staged-file.js");
    const write = async (allowDrvfsRenameRecovery: boolean) => {
      if (writer === "json") writeJsonSync(path.join(directory, "target"), { value: 1 }, { allowDrvfsRenameRecovery });
      else await writeCallbackSibling({
        tempDir: directory, tempName: "stage", allowDrvfsRenameRecovery,
        write: temp => { fs.writeFileSync(temp, "payload"); },
        resolveFinalPath: () => path.join(directory, "target"),
      });
    };
    await write(true);
    const open = vi.spyOn(fs, "openSync");
    await write(false);
    const ordinaryOpens = open.mock.calls.length;
    open.mockClear();
    await write(true);
    expect(open).toHaveBeenCalledTimes(ordinaryOpens);
    expect(probe).toHaveBeenCalledTimes(needsProbe(directory) ? 1 : 0);
  });
}

it.skipIf(process.platform === "win32")("does not retry a parent close that may have released its descriptor", async () => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "linux" });
  probe.mockReset().mockReturnValue(false);
  const { retainDrvfsParent } = await import("../src/drvfs-parent.js");
  const directory = await tempRoot("drvfs-parent-close-");
  const originalClose = fs.closeSync;
  let replacement: number | undefined;
  const close = vi.spyOn(fs, "closeSync").mockImplementation(fd => {
    originalClose(fd);
    if (replacement === undefined) {
      replacement = fs.openSync(path.join(directory, "replacement"), "w");
      throw Object.assign(new Error("close completed before reporting failure"), { code: "EIO" });
    }
  });
  try {
    // Major zero forces preparation even when the real test mount is a block device.
    expect(retainDrvfsParent(directory, 9n)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(fs.fstatSync(replacement!).isFile()).toBe(true);
  } finally {
    close.mockRestore();
    if (replacement !== undefined) originalClose(replacement);
  }
});
