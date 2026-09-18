import fs from "node:fs";
import path from "node:path";
import { assertAbsolutePathInput } from "./absolute-path.js";
import { resolveCopyCloneMode, type CopyCloneMode } from "./copy-policy.js";
import { copyOwnedTree } from "./copy-tree-portable.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { assertStagedDirectoryCurrent, openStagedDirectory } from "./staged-directory.js";
export { readCloneFileMetadata, type CloneFileMetadata } from "./clone-metadata.js";
export type { CopyCloneMode } from "./copy-policy.js";

export type TreeCloneBackend = "apfs" | "btrfs" | "refs" | "xfs" | "zfs";
export type CopyTreeOptions = {
  clone?: CopyCloneMode;
  signal?: AbortSignal;
  concurrency?: number;
};

/** Inspect an existing real directory without creating probe files. */
export function probeTreeClone(parentPath: string): TreeCloneBackend | undefined {
  const pathname = assertAbsolutePathInput(parentPath);
  const native = getNativeBinding();
  if (typeof native?.probeTreeClone !== "function") return undefined;
  const parent = openStagedDirectory(pathname);
  try {
    return native.probeTreeClone(parent.fd) ?? undefined;
  } finally {
    fs.closeSync(parent.fd);
  }
}

/** Create an empty clone source: a Btrfs subvolume or an ordinary supported directory. */
export async function createCloneSource(
  destination: string,
  options: Pick<CopyTreeOptions, "signal"> = {},
): Promise<void> {
  await materializeTree(undefined, destination, options, "always");
}

/** Copy an immutable, caller-owned tree, preferring native cloning unless configured otherwise. */
export async function copyTree(
  source: string,
  destination: string,
  options: CopyTreeOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const policy = resolveCopyCloneMode(options.clone, "auto");
  await materializeTree(source, destination, options, policy);
}

function cloneUnavailable(error: unknown): boolean {
  if (error instanceof FsSafeError && error.code === "unsupported-platform") return true;
  if (!(error instanceof Error) || !("code" in error)) return false;
  // ENOTSUP also describes unsupported contents (for example named streams).
  // Only capability failures may select a byte copy, never lossy source errors.
  return error.code === "CLONE_UNAVAILABLE" || error.code === "EXDEV" || error.code === "ENOSYS";
}

async function materializeTree(
  source: string | undefined,
  destination: string,
  options: CopyTreeOptions,
  policy: CopyCloneMode,
): Promise<void> {
  options.signal?.throwIfAborted();
  const concurrency = options.concurrency ?? 16;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new FsSafeError("invalid-path", "clone concurrency must be an integer between 1 and 32");
  }
  const native = policy === "never" ? undefined : getNativeBinding();
  const target = assertAbsolutePathInput(destination);
  const name = path.basename(target);
  if (!name) throw new FsSafeError("invalid-path", "clone destination must name a child directory");
  const parent = openStagedDirectory(path.dirname(target));
  let original: ReturnType<typeof openStagedDirectory> | undefined;
  try {
    const supported = typeof native?.probeTreeClone === "function" &&
      typeof native.cloneTree === "function" ? native.probeTreeClone(parent.fd) : undefined;
    if (source !== undefined) {
      original = openStagedDirectory(assertAbsolutePathInput(source));
      const relative = path.relative(
        original.receipt.realPath,
        path.join(parent.receipt.realPath, name),
      );
      if (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      ) {
        throw new FsSafeError("invalid-path", "clone destination must be outside the source tree");
      }
      assertStagedDirectoryCurrent(original.receipt);
    }
    assertStagedDirectoryCurrent(parent.receipt);
    options.signal?.throwIfAborted();
    let cloned = false;
    // napi-rs uses the supplied signal's onabort property. Give it a private
    // signal so caller handlers and other admitted native operations stay intact.
    const cancellation = options.signal && supported ? new AbortController() : undefined;
    const abort = () => cancellation?.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (native && supported) {
        await native.cloneTree(
          original?.fd ?? null,
          parent.fd,
          name,
          concurrency,
          cancellation?.signal,
        );
        cloned = true;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!cloneUnavailable(error)) throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    options.signal?.throwIfAborted();
    assertStagedDirectoryCurrent(parent.receipt);
    if (original) assertStagedDirectoryCurrent(original.receipt);
    if (!cloned && policy === "always") {
      warnNativeFallback("directory cloning", "An independent byte copy or ordinary source directory is used; filesystem cloning is not guaranteed.");
    }
    if (!cloned && original) {
      await copyOwnedTree(original, target, {
        signal: options.signal,
        concurrency: options.concurrency ?? (process.platform === "win32" ? 4 : 1),
        copyFileContents:
          process.platform === "win32" || process.platform === "linux"
            ? native?.copyFileContents
            : undefined,
      });
      options.signal?.throwIfAborted();
      assertStagedDirectoryCurrent(parent.receipt);
      assertStagedDirectoryCurrent(original.receipt);
    }
    if (!cloned && !original) {
      // Exclusive creation refuses existing names, including partial native output.
      assertStagedDirectoryCurrent(parent.receipt);
      fs.mkdirSync(target, { mode: 0o700 });
      const created = openStagedDirectory(target);
      try {
        assertStagedDirectoryCurrent(parent.receipt);
        assertStagedDirectoryCurrent(created.receipt);
      } finally {
        fs.closeSync(created.fd);
      }
    }
  } finally {
    try {
      if (original) fs.closeSync(original.fd);
    } finally {
      fs.closeSync(parent.fd);
    }
  }
}
