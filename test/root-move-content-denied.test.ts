import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as darwinCommand from "../src/darwin-move-command.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const darwinDenied = process.platform === "darwin" && process.getuid?.() !== 0;
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native CI supplies platform artifacts. */ }
const renameDarwin = darwinCommand.renameDarwinNoReplace;
type Backend = "off" | "missing-auto" | "native";

beforeEach(() => {
  __resetNativeFallbackWarningsForTest();
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeFallbackWarningsForTest();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});
function configure(backend: Backend) {
  configureFsSafeNative({ mode: backend === "off" ? "off" : backend === "native" ? "require" : "auto" });
  __setNativeLoaderForTest(() => {
    if (backend === "native") return native!;
    throw new Error("optional addon omitted");
  });
}
async function fixture(backend: Backend = "off") {
  configure(backend);
  const directory = await tempRoot("fs-safe-content-denied-move-");
  const source = path.join(directory, "source-é-🦀");
  const target = path.join(directory, "target-é-🦀");
  await fs.writeFile(source, "retained original");
  await fs.chmod(source, 0);
  return { directory, source, target, before: await fs.stat(source, { bigint: true }), scoped: await root(directory) };
}

for (const backend of ["off", "missing-auto", "native"] as const) {
  it.skipIf(!["linux", "darwin"].includes(process.platform) || (backend === "native" && !native))(
    `moves a mode000 regular file without changing its inode or permissions (${backend})`, async () => {
      const { source, target, before, scoped } = await fixture(backend);
      const chmod = vi.spyOn(fsSync, "chmodSync");
      const fchmod = vi.spyOn(fsSync, "fchmodSync");
      await expect(scoped.move(path.basename(source), path.basename(target))).resolves.toBeUndefined();
      expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode, nlink: 1n });
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(chmod).not.toHaveBeenCalled();
      expect(fchmod).not.toHaveBeenCalled();
      await fs.chmod(target, 0o600);
      expect(await fs.readFile(target, "utf8")).toBe("retained original");
    },
  );

  it.skipIf(!darwinDenied || (backend === "native" && !native))(
    `admits the Darwin source after awaited hooks, matching native (${backend})`, async () => {
      const { directory, source, target, scoped } = await fixture(backend);
      let selected: fsSync.BigIntStats | undefined;
      __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async () => {
        await fs.rename(source, path.join(directory, "retired"));
        await fs.writeFile(source, "selected after hook");
        await fs.chmod(source, 0);
        selected = await fs.stat(source, { bigint: true });
      } });
      await scoped.move(path.basename(source), path.basename(target));
      expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: selected!.dev, ino: selected!.ino, mode: selected!.mode, nlink: 1n });
      await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
}

it.skipIf(process.platform !== "linux")("uses a metadata-only Linux descriptor without data access", async () => {
  const { source, target, scoped } = await fixture();
  const open = fsSync.openSync.bind(fsSync);
  const flags: number[] = [];
  vi.spyOn(fsSync, "openSync").mockImplementation((file, mode, permissions) => {
    const fd = open(file, mode, permissions);
    if (String(file) === source) {
      flags.push(Number(mode));
      expect(() => fsSync.readSync(fd, Buffer.alloc(1), 0, 1, 0)).toThrow(expect.objectContaining({ code: "EBADF" }));
    }
    return fd;
  });
  await scoped.move(path.basename(source), path.basename(target));
  expect(flags).toHaveLength(1);
  expect(flags[0]! & 0x0020_0000).not.toBe(0);
  expect((await fs.stat(target)).mode & 0o777).toBe(0);
});

describe.runIf(darwinDenied)("Darwin content-denied atomic move", () => {
  it("warns about the actual command route and refuses a last-moment collision atomically", async () => {
    const { source, target, before, scoped } = await fixture();
    const command = vi.spyOn(darwinCommand, "renameDarwinNoReplace").mockImplementation(input => {
      fsSync.writeFileSync(target, "competitor", { flag: "wx" });
      renameDarwin(input);
    });
    const link = vi.spyOn(fsSync, "linkSync");
    await expect(scoped.move(path.basename(source), path.basename(target))).rejects.toMatchObject({ code: "already-exists" });
    expect(command).toHaveBeenCalledOnce();
    expect(link).not.toHaveBeenCalled();
    expect(await fs.stat(source, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
    expect(await fs.readFile(target, "utf8")).toBe("competitor");
    expect(process.emitWarning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Command startup adds overhead"), { code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning" },
    );
    expect(String(vi.mocked(process.emitWarning).mock.calls[0]![0])).not.toContain("hardlink");
  });

  it.each(["hook", "authority"] as const)("preserves a %s failure without dispatching", async phase => {
    const { source, target, before, scoped } = await fixture();
    const failure = Object.assign(new Error("authority expired"), { code: "ENOSYS" });
    if (phase === "hook") __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async () => { throw failure; } });
    const command = vi.spyOn(darwinCommand, "renameDarwinNoReplace");
    await expect(scoped.move(path.basename(source), path.basename(target), {
      assertBeforeMutation: phase === "authority" ? () => { throw failure; } : undefined,
    })).rejects.toBe(failure);
    expect(command).not.toHaveBeenCalled();
    expect(await fs.stat(source, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a source replaced by the live authority callback", async () => {
    const { directory, source, target, before, scoped } = await fixture();
    const retired = path.join(directory, "retired");
    const command = vi.spyOn(darwinCommand, "renameDarwinNoReplace");
    await expect(scoped.move(path.basename(source), path.basename(target), {
      assertBeforeMutation: () => { fsSync.renameSync(source, retired); fsSync.writeFileSync(source, "replacement"); },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(command).not.toHaveBeenCalled();
    expect(await fs.stat(retired, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
    expect(await fs.readFile(source, "utf8")).toBe("replacement");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["symlink", "hardlink", "directory"] as const)("rejects a %s source introduced by an awaited hook", async kind => {
    const { directory, source, target, scoped } = await fixture();
    const victim = path.join(directory, "victim");
    await fs.writeFile(victim, "preserve");
    __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async () => {
      await fs.rename(source, path.join(directory, "retired"));
      if (kind === "symlink") await fs.symlink(victim, source);
      else if (kind === "hardlink") await fs.link(victim, source);
      else await fs.mkdir(source);
    } });
    const command = vi.spyOn(darwinCommand, "renameDarwinNoReplace");
    await expect(scoped.move(path.basename(source), path.basename(target)))
      .rejects.toMatchObject({ code: kind === "directory" ? "invalid-path" : kind });
    expect(command).not.toHaveBeenCalled();
    expect(await fs.readFile(victim, "utf8")).toBe("preserve");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["root", "source", "target"] as const)("refences the retained %s parent after live authority", async boundary => {
    const base = await tempRoot("fs-safe-command-move-parent-");
    const directory = path.join(base, "root");
    const incoming = path.join(directory, "incoming"), outgoing = path.join(directory, "outgoing");
    await fs.mkdir(incoming, { recursive: true }); await fs.mkdir(outgoing);
    const source = path.join(incoming, "source"); await fs.writeFile(source, "preserve"); await fs.chmod(source, 0);
    configure("off");
    const scoped = await root(directory);
    const changed = boundary === "root" ? directory : boundary === "source" ? incoming : outgoing;
    const moved = path.join(base, "moved");
    const command = vi.spyOn(darwinCommand, "renameDarwinNoReplace");
    await expect(scoped.move("incoming/source", "outgoing/target", {
      assertBeforeMutation: () => { fsSync.renameSync(changed, moved); fsSync.mkdirSync(changed); },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(command).not.toHaveBeenCalled();
    const retainedSource = boundary === "root" ? path.join(moved, "incoming/source")
      : boundary === "source" ? path.join(moved, "source") : source;
    expect((await fs.stat(retainedSource)).mode & 0o777).toBe(0);
  });

  it.each(["io-error", "target-replacement"] as const)("preserves completed rename after %s without retry or rollback", async failureKind => {
    const { directory, source, target, before, scoped } = await fixture();
    const failure = Object.assign(new Error("rename response lost"), { code: "EIO" });
    const retired = path.join(directory, "retired");
    const command = vi.spyOn(darwinCommand, "renameDarwinNoReplace").mockImplementation(input => {
      renameDarwin(input);
      if (failureKind === "io-error") throw failure;
      fsSync.renameSync(target, retired); fsSync.writeFileSync(target, "replacement");
    });
    const pending = scoped.move(path.basename(source), path.basename(target));
    if (failureKind === "io-error") await expect(pending).rejects.toBe(failure);
    else await expect(pending).rejects.toMatchObject({ code: "path-mismatch", details: { commit: "committed", sourceConsumed: true } });
    expect(command).toHaveBeenCalledOnce();
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(failureKind === "io-error" ? target : retired, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
    if (failureKind === "target-replacement") expect(await fs.readFile(target, "utf8")).toBe("replacement");
  });

  it.each([1, 2])("retains the committed public move after post-command target check %s fails", async check => {
    const { source, target, before, scoped } = await fixture();
    const failure = Object.assign(new Error("post-command target observation failed"), { code: "EIO" });
    const lstat = fsSync.lstatSync.bind(fsSync);
    let checks = 0;
    let injected = false;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((file, options) => {
      if (String(file) === target && !fsSync.existsSync(source) && ++checks === check) {
        injected = true;
        throw failure;
      }
      return lstat(file, options);
    });
    const command = vi.spyOn(darwinCommand, "renameDarwinNoReplace");
    await expect(scoped.move(path.basename(source), path.basename(target))).rejects.toMatchObject({
      code: "helper-failed", cause: failure, details: { commit: "committed", sourceConsumed: true },
    });
    expect(injected).toBe(true);
    expect(command).toHaveBeenCalledOnce();
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
    await fs.chmod(target, 0o600);
    expect(await fs.readFile(target, "utf8")).toBe("retained original");
  });

  it.each([false, true])("closes each retained parent once and preserves errors (operation failure=%s)", async failOperation => {
    const { source, target, before, scoped } = await fixture();
    const operationFailure = Object.assign(new Error("command failed"), { code: "EIO" });
    const closeFailure = Object.assign(new Error("parent close failed"), { code: "EIO" });
    if (failOperation) vi.spyOn(darwinCommand, "renameDarwinNoReplace").mockImplementation(() => { throw operationFailure; });
    const close = fsSync.closeSync.bind(fsSync);
    const closeSpy = vi.spyOn(fsSync, "closeSync").mockImplementation(fd => { close(fd); throw closeFailure; });
    const pending = scoped.move(path.basename(source), path.basename(target));
    if (failOperation) await expect(pending).rejects.toMatchObject({ name: "SuppressedError", error: closeFailure, suppressed: operationFailure });
    else await expect(pending).rejects.toMatchObject({ cause: closeFailure, details: { commit: "committed", sourceConsumed: true } });
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(await fs.stat(failOperation ? source : target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
    await expect(fs.lstat(failOperation ? target : source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
