import fs from "node:fs";
import path from "node:path";
import { assertAbsolutePathInput } from "./absolute-path.js";
import { resolveCopyCloneMode, type CopyCloneMode } from "./copy-policy.js";
import { copyOwnedTree } from "./copy-tree-portable.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding, requireNativeBinding } from "./native.js";
import { assertStagedDirectoryCurrent, openStagedDirectory } from "./staged-directory.js";
export { readCloneFileMetadata, type CloneFileMetadata } from "./clone-metadata.js";
export type { CopyCloneMode } from "./copy-policy.js";

export type TreeCloneBackend = "apfs" | "btrfs" | "refs" | "xfs";
export type CopyTreeOptions = {
  clone?: CopyCloneMode;
  signal?: AbortSignal;
  concurrency?: number;
};

/** Inspect an existing real directory without creating probe files. */
export function probeTreeClone(parentPath: string): TreeCloneBackend | undefined {
  const native = getNativeBinding();
  if (!native) return undefined;
  const parent = openStagedDirectory(assertAbsolutePathInput(parentPath));
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
  const native =
    policy === "always"
      ? requireNativeBinding()
      : policy === "auto"
        ? getNativeBinding()
        : undefined;
  const target = assertAbsolutePathInput(destination);
  const name = path.basename(target);
  if (!name) throw new FsSafeError("invalid-path", "clone destination must name a child directory");
  const parent = openStagedDirectory(path.dirname(target));
  let original: ReturnType<typeof openStagedDirectory> | undefined;
  try {
    const supported = native?.probeTreeClone(parent.fd);
    if (!supported && policy === "always") {
      throw new FsSafeError(
        "unsupported-platform",
        "destination filesystem does not support tree cloning",
      );
    }
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
      if (policy !== "auto" || !cloneUnavailable(error)) {
        if (error instanceof Error && "code" in error && error.code === "CLONE_UNAVAILABLE") {
          throw new FsSafeError("unsupported-platform", error.message, { cause: error });
        }
        throw error;
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    options.signal?.throwIfAborted();
    assertStagedDirectoryCurrent(parent.receipt);
    if (original) assertStagedDirectoryCurrent(original.receipt);
    if (!cloned && original) {
      await copyOwnedTree(original, target, {
        signal: options.signal,
        concurrency: options.concurrency ?? (process.platform === "win32" ? 4 : 1),
        copyFileContents: process.platform === "win32" ? native?.copyFileContents : undefined,
      });
      options.signal?.throwIfAborted();
      assertStagedDirectoryCurrent(parent.receipt);
      assertStagedDirectoryCurrent(original.receipt);
    }
  } finally {
    try {
      if (original) fs.closeSync(original.fd);
    } finally {
      fs.closeSync(parent.fd);
    }
  }
}
