import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renameNoReplaceWithCommand, type AtomicRenameOutcome } from "../src/atomic-rename-command.js";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "../src/directory-mode-node.js";
import { FsSafeError } from "../src/errors.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../src/darwin-move-command.js", () => ({ renameDarwinNoReplace: command }));
vi.mock("../src/linux-rename-command.js", () => ({ renameLinuxNoReplaceSync: command }));

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const borrowedFds = new Set<number>();
const real = {
  open: fs.openSync.bind(fs), close: fs.closeSync.bind(fs),
  lstat: fs.lstatSync.bind(fs), fstat: fs.fstatSync.bind(fs),
};
type Params = Parameters<typeof renameNoReplaceWithCommand>[0];

beforeEach(() => {
  command.mockReset();
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  command.mockImplementation(({ source, target }) => {
    fs.renameSync(path.join(source.parentPath, source.basename), path.join(target.parentPath, target.basename));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", architecture);
  for (const fd of borrowedFds) real.close(fd);
  borrowedFds.clear();
});

async function fixture(sharedParent = false) {
  const directory = await tempRoot("fs-safe-atomic-owner-");
  const sourceDirectory = path.join(directory, "from");
  const targetDirectory = sharedParent ? sourceDirectory : path.join(directory, "to");
  fs.mkdirSync(sourceDirectory);
  if (!sharedParent) fs.mkdirSync(targetDirectory);
  const sourcePath = path.join(sourceDirectory, "source");
  const targetPath = path.join(targetDirectory, "target");
  fs.writeFileSync(sourcePath, "original", { mode: 0o640 });
  const sourceParent = await createAsyncDirectoryGuard(sourceDirectory, { bigint: true });
  const targetParent = sharedParent ? sourceParent : await createAsyncDirectoryGuard(targetDirectory, { bigint: true });
  const fd = real.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  borrowedFds.add(fd);
  const outcomes: AtomicRenameOutcome[] = [];
  const params: Params = {
    source: { path: sourcePath, parent: sourceParent, identity: real.fstat(fd, { bigint: true }), fd },
    target: { path: targetPath, parent: targetParent },
    root: { path: directory, identity: real.lstat(directory, { bigint: true }) },
    assertCurrent: vi.fn(),
    onOutcome: (outcome) => { outcomes.push(outcome); },
  };
  return { directory, sourceDirectory, targetDirectory, sourcePath, targetPath, outcomes, fd, params };
}

function errno(code = "EIO") {
  return Object.assign(new Error(`injected ${code}`), { code });
}

function expectCommitted(paths: Awaited<ReturnType<typeof fixture>>) {
  expect(paths.outcomes).toEqual(["unknown", "committed"]);
  expect(command).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(paths.targetPath, "utf8")).toBe("original");
  expect(fs.existsSync(paths.sourcePath)).toBe(false);
  expect(real.fstat(paths.fd, { bigint: true }).ino).toBe(paths.params.source.identity.ino);
}

const describePosix = describe.runIf(
  ["darwin", "linux"].includes(process.platform) && nodeDirectorySearchOnlyFlags() !== undefined,
);

describe.runIf(["darwin", "linux"].includes(process.platform))("atomic command Linux architecture selection", () => {
  it.each(["arm", "ia32", "loong64", "mips", "mipsel", "mips64el", "ppc", "ppc64", "riscv64", "s390", "s390x"])(
    "reaches the Linux command with pinned parents on %s", async arch => {
      const paths = await fixture();
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: arch });
      // Exercise the Linux selection using real host descriptors, without
      // passing Linux-specific flag bits to another host's open syscall.
      const open = vi.spyOn(fs, "openSync").mockImplementation((name) => {
        return real.open(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      });

      await renameNoReplaceWithCommand(paths.params);
      expectCommitted(paths);
      expect(open).toHaveBeenCalledTimes(2);
      for (const [, flags] of open.mock.calls) {
        expect(flags).toBe(0x200000 | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      }
      const input = command.mock.calls[0]![0];
      expect(input.source.parentFd).toBe(open.mock.results[0]!.value);
      expect(input.target.parentFd).toBe(open.mock.results[1]!.value);
    },
  );
});

describePosix("atomic command owner outcomes", () => {
  it("records commit before observers and closes each parent once without closing the borrowed source", async () => {
    const paths = await fixture();
    const close = vi.spyOn(fs, "closeSync");
    const open = vi.spyOn(fs, "openSync");
    paths.params.onOutcome = outcome => {
      paths.outcomes.push(outcome);
      if (outcome !== "committed") return;
      expect(paths.outcomes).toEqual(["unknown", "committed"]);
      expect(close).not.toHaveBeenCalled();
      expect(real.fstat(paths.fd, { bigint: true }).ino).toBe(paths.params.source.identity.ino);
    };

    await renameNoReplaceWithCommand(paths.params);
    expectCommitted(paths);
    const parents = open.mock.results.map(result => result.value as number);
    expect(parents).toHaveLength(2);
    expect(close.mock.calls.map(([fd]) => fd)).toEqual(parents);
    expect(close).not.toHaveBeenCalledWith(paths.fd);
    expect(real.lstat(paths.targetPath, { bigint: true })).toMatchObject({
      ino: paths.params.source.identity.ino, mode: paths.params.source.identity.mode,
    });
  });

  it("retains one descriptor when source and target share the same guard", async () => {
    const paths = await fixture(true);
    const close = vi.spyOn(fs, "closeSync");
    await renameNoReplaceWithCommand(paths.params);
    expectCommitted(paths);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["target-stat", "parent-stat", "source-fd", "close"])(
    "retains confirmed commit after a %s failure", async (phase) => {
      const paths = await fixture();
      const failure = errno();
      let renamed = false;
      command.mockImplementation(() => {
        fs.renameSync(paths.sourcePath, paths.targetPath);
        renamed = true;
      });
      vi.spyOn(fs, "lstatSync").mockImplementation(((name, options) => {
        if (renamed && ((phase === "target-stat" && String(name) === paths.targetPath) ||
          (phase === "parent-stat" && String(name) === paths.targetDirectory))) throw failure;
        return real.lstat(name, options as never);
      }) as typeof fs.lstatSync);
      vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
        if (renamed && phase === "source-fd" && fd === paths.fd) throw failure;
        return real.fstat(fd, options as never);
      }) as typeof fs.fstatSync);
      if (phase === "close") vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
        real.close(fd);
        throw failure;
      });

      await expect(renameNoReplaceWithCommand(paths.params)).rejects.toMatchObject({
        code: "helper-failed", details: { commit: "committed", sourceConsumed: true },
      });
      expectCommitted(paths);
    },
  );

  it.each([false, true])("preserves unknown outcome without retry when rename happened: %s", async (renamed) => {
    const paths = await fixture();
    const remove = vi.spyOn(fs, "unlinkSync");
    command.mockImplementation(() => {
      if (renamed) fs.renameSync(paths.sourcePath, paths.targetPath);
      throw new FsSafeError("helper-failed", "missing command receipt", { details: { commit: "unknown" } });
    });

    const error = await renameNoReplaceWithCommand(paths.params).catch(error => error as FsSafeError);
    expect(error).toMatchObject({ code: "helper-failed", details: { commit: "unknown" } });
    expect(error.details).not.toHaveProperty("sourceConsumed");
    expect(paths.outcomes).toEqual(["unknown"]);
    expect(command).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(fs.readFileSync(renamed ? paths.targetPath : paths.sourcePath, "utf8")).toBe("original");
    expect(fs.existsSync(renamed ? paths.sourcePath : paths.targetPath)).toBe(false);
  });

  it("records a committed adapter receipt even when the adapter throws", async () => {
    const paths = await fixture();
    const failure = new FsSafeError("helper-failed", "command cleanup failed", { details: { commit: "committed" } });
    command.mockImplementation(() => {
      fs.renameSync(paths.sourcePath, paths.targetPath);
      throw failure;
    });

    await expect(renameNoReplaceWithCommand(paths.params)).rejects.toMatchObject({
      details: { commit: "committed", sourceConsumed: true }, cause: failure,
    });
    expectCommitted(paths);
  });

  it("accepts an adapter's explicit not-attempted receipt without claiming publication", async () => {
    const paths = await fixture();
    const failure = new FsSafeError("helper-unavailable", "executable absent", { details: { commit: "not-attempted" } });
    command.mockImplementation(() => { throw failure; });

    await expect(renameNoReplaceWithCommand(paths.params)).rejects.toBe(failure);
    expect(paths.outcomes).toEqual(["unknown", "not-attempted"]);
    expect(command).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(paths.sourcePath, "utf8")).toBe("original");
    expect(fs.existsSync(paths.targetPath)).toBe(false);
  });

  it("accepts explicit admission provenance on an adapter's ordinary OS error", async () => {
    const paths = await fixture();
    const failure = Object.assign(errno("EACCES"), { phase: "admission", commit: "not-attempted" });
    command.mockImplementation(() => { throw failure; });

    await expect(renameNoReplaceWithCommand(paths.params)).rejects.toBe(failure);
    expect(paths.outcomes).toEqual(["unknown", "not-attempted"]);
    expect(command).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(paths.sourcePath, "utf8")).toBe("original");
    expect(fs.existsSync(paths.targetPath)).toBe(false);
  });

  it("preserves the operation and both parent close errors", async () => {
    const paths = await fixture();
    const operationFailure = errno("ETIMEDOUT");
    const closeFailures = [errno(), errno("ENOSPC")];
    command.mockImplementation(() => { throw operationFailure; });
    const close = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      real.close(fd);
      throw closeFailures[close.mock.calls.length - 1];
    });

    const error = await renameNoReplaceWithCommand(paths.params).catch(error => error as FsSafeError);
    expect(error).toMatchObject({
      details: { commit: "unknown" },
      cause: { name: "SuppressedError", suppressed: operationFailure, error: { errors: closeFailures } },
    });
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalledWith(paths.fd);
    expect(real.fstat(paths.fd, { bigint: true }).ino).toBe(paths.params.source.identity.ino);
  });
});

describePosix("atomic command owner authority", () => {
  it.each(["authority", "hook"])("ignores a forged committed receipt from a pre-dispatch %s", async (origin) => {
    const paths = await fixture();
    const failure = new FsSafeError("path-mismatch", "authority revoked", { details: { commit: "committed" } });
    if (origin === "authority") paths.params.assertCurrent = () => { throw failure; };
    else paths.params.assertBeforeMutation = () => { throw failure; };

    await expect(renameNoReplaceWithCommand(paths.params)).rejects.toBe(failure);
    expect(paths.outcomes).toEqual([]);
    expect(command).not.toHaveBeenCalled();
    expect(fs.readFileSync(paths.sourcePath, "utf8")).toBe("original");
    expect(fs.existsSync(paths.targetPath)).toBe(false);
  });

  it.each(["source", "source-symlink", "source-parent", "target-parent", "target-parent-symlink", "hardlink"])(
    "rejects a %s substitution by admission authority before dispatch", async (substitution) => {
      const paths = await fixture();
      const saved = path.join(paths.directory, "saved");
      paths.params.assertBeforeMutation = () => {
        if (substitution === "hardlink") {
          fs.linkSync(paths.sourcePath, saved);
        } else if (substitution.startsWith("source") && !substitution.includes("parent")) {
          fs.renameSync(paths.sourcePath, saved);
          if (substitution === "source-symlink") fs.symlinkSync(saved, paths.sourcePath);
          else fs.writeFileSync(paths.sourcePath, "replacement");
        } else {
          const directory = substitution === "source-parent" ? paths.sourceDirectory : paths.targetDirectory;
          fs.renameSync(directory, saved);
          if (substitution === "target-parent-symlink") fs.symlinkSync(saved, directory);
          else fs.mkdirSync(directory);
        }
      };

      await expect(renameNoReplaceWithCommand(paths.params)).rejects.toMatchObject({
        code: substitution === "target-parent-symlink" ? "not-file" : "path-mismatch",
      });
      expect(command).not.toHaveBeenCalled();
      expect(paths.outcomes).toEqual([]);
      expect(fs.existsSync(paths.targetPath)).toBe(false);
      expect(real.fstat(paths.fd, { bigint: true }).ino).toBe(paths.params.source.identity.ino);
    },
  );

  it("performs final authority and filesystem checks in the same turn as dispatch", async () => {
    const paths = await fixture();
    let yielded = false;
    let authorityCalls = 0;
    paths.params.assertCurrent = () => {
      authorityCalls++;
      queueMicrotask(() => { yielded = true; });
    };
    paths.params.assertBeforeMutation = () => { expect(yielded).toBe(false); };
    command.mockImplementation(() => {
      expect(authorityCalls).toBe(2);
      expect(yielded).toBe(false);
      fs.renameSync(paths.sourcePath, paths.targetPath);
    });

    await renameNoReplaceWithCommand(paths.params);
    expectCommitted(paths);
    expect(yielded).toBe(true);
  });

  it("closes a rejected parent descriptor and an already admitted parent exactly once", async () => {
    const paths = await fixture();
    let openedTarget: number | undefined;
    const open = vi.spyOn(fs, "openSync").mockImplementation(((name, flags, mode) => {
      const fd = real.open(name, flags, mode);
      if (String(name) === paths.targetDirectory) openedTarget = fd;
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
      if (fd === openedTarget) return { ...paths.params.target.parent.stat, ino: -1n };
      return real.fstat(fd, options as never);
    }) as typeof fs.fstatSync);
    const close = vi.spyOn(fs, "closeSync");

    await expect(renameNoReplaceWithCommand(paths.params)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(command).not.toHaveBeenCalled();
    expect(close.mock.calls.map(([fd]) => fd).sort()).toEqual(open.mock.results.map(result => result.value).sort());
    expect(close).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalledWith(paths.fd);
  });

  it("keeps confirmed state if an outcome observer throws before postchecks", async () => {
    const paths = await fixture();
    paths.params.onOutcome = outcome => {
      paths.outcomes.push(outcome);
      if (outcome === "committed") throw errno();
    };
    await expect(renameNoReplaceWithCommand(paths.params)).rejects.toMatchObject({
      details: { commit: "committed", sourceConsumed: true },
    });
    expectCommitted(paths);
  });
});

describePosix("atomic command owner non-destructive failure handling", () => {
  it("preserves both names when a source name is recreated after atomic rename", async () => {
    const paths = await fixture();
    command.mockImplementation(() => {
      fs.renameSync(paths.sourcePath, paths.targetPath);
      fs.writeFileSync(paths.sourcePath, "replacement");
    });
    await expect(renameNoReplaceWithCommand(paths.params)).rejects.toMatchObject({
      code: "path-mismatch", details: { commit: "committed", sourceConsumed: true },
    });
    expect(command).toHaveBeenCalledTimes(1);
    expect(paths.outcomes).toEqual(["unknown", "committed"]);
    expect(fs.readFileSync(paths.sourcePath, "utf8")).toBe("replacement");
    expect(fs.readFileSync(paths.targetPath, "utf8")).toBe("original");
  });

  it("normalizes a raced destination collision without retrying or removing either file", async () => {
    const paths = await fixture();
    command.mockImplementation(() => {
      fs.writeFileSync(paths.targetPath, "competitor");
      throw errno("EEXIST");
    });
    await expect(renameNoReplaceWithCommand(paths.params)).rejects.toMatchObject({
      code: "already-exists", details: { commit: "unknown" },
    });
    expect(command).toHaveBeenCalledTimes(1);
    expect(paths.outcomes).toEqual(["unknown"]);
    expect(fs.readFileSync(paths.sourcePath, "utf8")).toBe("original");
    expect(fs.readFileSync(paths.targetPath, "utf8")).toBe("competitor");
  });

  it.each(["EEXIST", "ENOTEMPTY", "EINVAL", "ENOSYS", "EACCES", "EXDEV", "EIO"])(
    "keeps a committed rename followed by ordinary %s indeterminate", async code => {
      const paths = await fixture();
      const remove = vi.spyOn(fs, "unlinkSync");
      command.mockImplementation(() => {
        fs.renameSync(paths.sourcePath, paths.targetPath);
        throw Object.assign(errno(code), { phase: "rename", commit: "not-attempted" });
      });

      const error = await renameNoReplaceWithCommand(paths.params).catch(error => error as FsSafeError);
      expect(error).toMatchObject({
        code: ["EEXIST", "ENOTEMPTY"].includes(code) ? "already-exists" : "helper-failed",
        details: { commit: "unknown" },
      });
      expect(error.details).not.toHaveProperty("sourceConsumed");
      expect(paths.outcomes).toEqual(["unknown"]);
      expect(command).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
      expect(fs.existsSync(paths.sourcePath)).toBe(false);
      expect(fs.readFileSync(paths.targetPath, "utf8")).toBe("original");
    },
  );

  it("does not promote an outcome observer's forged committed marker", async () => {
    const paths = await fixture();
    paths.params.onOutcome = outcome => {
      paths.outcomes.push(outcome);
      throw new FsSafeError("helper-failed", "observer failed", {
        details: { commit: "committed", sourceConsumed: true },
      });
    };
    const error = await renameNoReplaceWithCommand(paths.params).catch(error => error as FsSafeError);
    expect(error).toMatchObject({ details: { commit: "unknown" } });
    expect(error.details).not.toHaveProperty("sourceConsumed");
    expect(command).not.toHaveBeenCalled();
    expect(paths.outcomes).toEqual(["unknown"]);
    expect(fs.readFileSync(paths.sourcePath, "utf8")).toBe("original");
    expect(fs.existsSync(paths.targetPath)).toBe(false);
  });

  it("can retain parent-only custody without opening unreadable source content", async () => {
    const paths = await fixture();
    real.close(paths.fd);
    borrowedFds.delete(paths.fd);
    delete paths.params.source.fd;
    fs.chmodSync(paths.sourcePath, 0o000);
    paths.params.source.identity = real.lstat(paths.sourcePath, { bigint: true });
    const open = vi.spyOn(fs, "openSync");
    try {
      await renameNoReplaceWithCommand(paths.params);
      expect(paths.outcomes).toEqual(["unknown", "committed"]);
      expect(open.mock.calls.map(([name]) => name)).toEqual([paths.sourceDirectory, paths.targetDirectory]);
      expect(real.lstat(paths.targetPath, { bigint: true })).toMatchObject({
        ino: paths.params.source.identity.ino, mode: paths.params.source.identity.mode,
      });
      expect(fs.existsSync(paths.sourcePath)).toBe(false);
    } finally {
      fs.chmodSync(fs.existsSync(paths.targetPath) ? paths.targetPath : paths.sourcePath, 0o600);
    }
    expect(fs.readFileSync(paths.targetPath, "utf8")).toBe("original");
  });
});
