import fs from "node:fs";
import path from "node:path";
import { assertAbsolutePathInput } from "./absolute-path.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding, requireNativeBinding } from "./native.js";
import { assertStagedDirectoryCurrent, openStagedDirectory } from "./staged-directory.js";
export { readCloneFileMetadata, type CloneFileMetadata } from "./clone-metadata.js";

export type TreeCloneBackend = "apfs" | "btrfs" | "refs";
export type CloneTreeOptions = { signal?: AbortSignal; concurrency?: number };

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

/** Create an empty clone source: a Btrfs subvolume or an ordinary APFS/ReFS directory. */
export async function createCloneSource(
  destination: string,
  options: Pick<CloneTreeOptions, "signal"> = {},
): Promise<void> {
  await clone(undefined, destination, options);
}

/** Clone an immutable, caller-owned tree into an absent destination, without byte-copy fallback. */
export async function cloneTree(
  source: string,
  destination: string,
  options: CloneTreeOptions = {},
): Promise<void> {
  await clone(source, destination, options);
}

async function clone(
  source: string | undefined,
  destination: string,
  options: CloneTreeOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  const concurrency = options.concurrency ?? 16;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new FsSafeError("invalid-path", "clone concurrency must be an integer between 1 and 32");
  }
  const native = requireNativeBinding();
  const target = assertAbsolutePathInput(destination);
  const name = path.basename(target);
  if (!name) throw new FsSafeError("invalid-path", "clone destination must name a child directory");
  const parent = openStagedDirectory(path.dirname(target));
  let original: ReturnType<typeof openStagedDirectory> | undefined;
  try {
    if (!native.probeTreeClone(parent.fd)) {
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
    // napi-rs uses the supplied signal's onabort property. Give it a private
    // signal so caller handlers and other admitted native operations stay intact.
    const cancellation = options.signal ? new AbortController() : undefined;
    const abort = () => cancellation?.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await native.cloneTree(
        original?.fd ?? null,
        parent.fd,
        name,
        concurrency,
        cancellation?.signal,
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    options.signal?.throwIfAborted();
    assertStagedDirectoryCurrent(parent.receipt);
    if (original) assertStagedDirectoryCurrent(original.receipt);
  } finally {
    try {
      if (original) fs.closeSync(original.fd);
    } finally {
      fs.closeSync(parent.fd);
    }
  }
}
