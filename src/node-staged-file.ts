import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import type { CopyFileInput } from "./copy-file-input.js";
import { syncDirectorySync } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { syncFileBestEffortSync } from "./file-sync.js";
import type { NativeFileCopyResult } from "./native-binding.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { assertStagedDirectoryCurrent } from "./staged-directory.js";
import type { StagedFileCleanupReceipt, StagedFileReceipt } from "./staged-file-types.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { isHardlinkCapabilityError } from "./linux-rename-command.js";
import { renameSiblingNoReplaceSync } from "./sibling-rename-command.js";

export type StagedFileDispatch = Readonly<{ method: "rename" | "link-unlink" }>;

export type StagedFileMechanism = {
  targeting: StagedFileReceipt["targeting"];
  create(name: string): number;
  matches(name: string, fd: number): boolean;
  publish(name: string, basename: string, overwrite: boolean, fd: number): StagedFileDispatch;
  remove(name: string, fd: number, publishedBasename?: string): StagedFileCleanupReceipt["status"];
  close(fd: number): void;
  syncParent(): void;
  reopenPublished?(basename: string, fd: number): number;
  copy?(input: CopyFileInput, name: string, maxBytes?: number): Promise<NativeFileCopyResult | undefined>;
};

/** Node owns the descriptors; pathname mutations retain the guarded fallback boundary. */
export function createNodeStagingMechanism(
  parentFd: number,
  directory: StagedFileReceipt["directory"],
): StagedFileMechanism {
  assertNoWindowsPathAlias(directory.path, "filesystem");
  assertNoWindowsPathAlias(directory.realPath, "filesystem");
  const namedPath = (name: string) => path.join(directory.realPath, name);
  const assertParent = () => {
    const opened = inspectFileIdentitySync(
      () => fs.fstatSync(parentFd, { bigint: true }), directory.identity,
    );
    if (!opened.isDirectory()) throw new FsSafeError("path-mismatch", "staging parent descriptor changed");
    assertStagedDirectoryCurrent(directory);
  };
  const inspectNamed = (name: string, expected: BigIntStats) => inspectFileIdentitySync(() => {
    const current = fs.lstatSync(namedPath(name), { bigint: true });
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new FsSafeError("path-mismatch", "staged entry is no longer a regular file");
    }
    return current;
  }, expected);
  const inspectDescriptor = (fd: number) => inspectFileIdentitySync(() => {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new FsSafeError("path-mismatch", "staged descriptor is no longer a regular file");
    return opened;
  });
  const canPreserve = (error: unknown) =>
    (error instanceof FsSafeError && error.code === "path-mismatch") ||
    ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException)?.code ?? "");
  const parentCurrent = () => {
    try {
      assertParent();
      return true;
    } catch (error) {
      if (canPreserve(error)) return false;
      throw error;
    }
  };

  return {
    targeting: "guarded-pathname",
    create(name) {
      assertParent();
      // Return the exclusive descriptor directly; the lifecycle adopts it
      // before performing any fallible metadata or permission checks.
      return fs.openSync(
        namedPath(name),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | resolveReadOpenFlags(),
        0o600,
      );
    },
    matches(name, fd) {
      assertParent();
      const opened = inspectDescriptor(fd);
      let current: BigIntStats;
      try {
        current = inspectNamed(name, opened);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw error;
      }
      assertParent();
      return opened.nlink === 1n && current.nlink === 1n;
    },
    publish(name, basename, overwrite, fd) {
      // The shared owner checks the parent and stage immediately before this
      // synchronous dispatch and records success before any later inspection.
      if (overwrite) {
        fs.renameSync(namedPath(name), namedPath(basename));
        return { method: "rename" };
      }
      try {
        fs.linkSync(namedPath(name), namedPath(basename));
        return { method: "link-unlink" };
      } catch (error) {
        if (!isHardlinkCapabilityError(error)) throw error;
      }
      let source: BigIntStats;
      try {
        assertParent();
        source = inspectDescriptor(fd);
        if (source.nlink !== 1n || inspectNamed(name, source).nlink !== 1n) {
          throw new FsSafeError("path-mismatch", "staged source changed before atomic publication fallback");
        }
        assertParent();
      } catch (error) {
        throw new FsSafeError(error instanceof FsSafeError ? error.code : "helper-failed", "atomic staging fallback admission failed", {
          cause: error, details: { commit: "not-attempted" },
        });
      }
      warnNativeFallback("staged-file-atomic-publication", "A system command preserves atomic no-replace publication when hardlinks are unavailable; process startup adds overhead.");
      renameSiblingNoReplaceSync({
        parent: { path: directory.realPath, identity: directory.identity, fd: parentFd },
        source: { basename: name, identity: source, links: 1n, fd },
        targetBasename: basename,
      });
      return { method: "rename" };
    },
    remove(name, fd, publishedBasename) {
      if (!parentCurrent()) return "preserved";
      let opened: BigIntStats;
      let current: BigIntStats;
      try {
        opened = inspectDescriptor(fd);
        current = inspectNamed(name, opened);
      } catch (error) {
        if (!parentCurrent()) return "preserved";
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "name-absent";
        if (canPreserve(error)) return "preserved";
        throw error;
      }
      if (current.nlink !== opened.nlink) return "preserved";
      if (current.nlink === 2n && publishedBasename !== undefined) {
        try {
          if (inspectNamed(publishedBasename, opened).nlink !== 2n) return "preserved";
        } catch (error) {
          if (canPreserve(error)) return "preserved";
          throw error;
        }
      } else if (current.nlink !== 1n) {
        return "preserved";
      }
      if (!parentCurrent()) return "preserved";
      fs.unlinkSync(namedPath(name));
      assertParent();
      return "removed";
    },
    close: (fd) => fs.closeSync(fd),
    reopenPublished: process.platform === "win32" ? (basename, fd) => {
      assertParent();
      const expected = inspectDescriptor(fd);
      if (expected.nlink !== 2n || inspectNamed(basename, expected).nlink !== 2n) {
        throw new FsSafeError("path-mismatch", "published stage link changed before descriptor transfer");
      }
      const replacement = fs.openSync(namedPath(basename), fs.constants.O_WRONLY | resolveReadOpenFlags());
      try {
        const opened = inspectFileIdentitySync(() => fs.fstatSync(replacement, { bigint: true }), expected);
        if (!opened.isFile() || opened.nlink !== 2n || inspectNamed(basename, opened).nlink !== 2n) {
          throw new FsSafeError("path-mismatch", "published stage descriptor changed during transfer");
        }
        assertParent();
        return replacement;
      } catch (error) {
        try {
          fs.closeSync(replacement);
        } catch (closeError) {
          throw new AggregateError([error, closeError], "published stage descriptor admission and close failed");
        }
        throw error;
      }
    } : undefined,
    syncParent() {
      assertParent();
      if (process.platform === "win32") {
        const outcome = syncDirectorySync(directory.path);
        if (outcome.status === "unsupported") {
          warnNativeFallback("staged-file-directory-sync", "The platform cannot synchronize the publication directory; crash durability is not guaranteed.");
        }
      } else {
        syncFileBestEffortSync(parentFd);
      }
      assertParent();
    },
  };
}
