import fsSync, { type BigIntStats } from "node:fs";
import type { OpenResult } from "./root-impl.js";
import type { RootContext } from "./root-context.js";
import type { RootCopyOptions, RootCopySource, HardlinkPolicy } from "./root-options.js";
import { assertCopySourceCurrent, resolveFileCopyCloneMode } from "./copy-file-input.js";
import { resolveCopyCloneMode } from "./copy-policy.js";
import { captureCopyMetadata } from "./copy-metadata.js";
import { admitCopyLink, assertCopyLinkAvailable } from "./copy-link.js";
import { assertAbsolutePathInput } from "./absolute-path.js";
import { assertNoNulPathInput } from "./path.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import { serializePathWrite } from "./write-queue.js";
import { rootWriteQueueKey } from "./root-create-native.js";
import { resolvePinnedWriteTargetInRoot } from "./root-write-admission.js";
import { createCopyPublicationObserver, onCopyPublication, onCopySourceAdmission, type CopyPublicationOptions } from "./copy-publication.js";
import { isAlreadyExistsError, normalizePinnedWriteError } from "./root-errors.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import type { PinnedWriteInput } from "./pinned-write-types.js";
import { FsSafeError } from "./errors.js";

type RootCopyParams = RootCopyOptions & {
  source: RootCopySource;
  relativePath: string;
  verifyPublished?: CopyPublicationOptions[typeof onCopyPublication];
  admitSource?: CopyPublicationOptions[typeof onCopySourceAdmission];
};

export async function copyFileInRoot(root: RootContext, params: RootCopyParams,
  openVerifiedLocalFile: (path: string, options: { hardlinks?: HardlinkPolicy }) => Promise<{ opened: OpenResult; identity: BigIntStats }>,
): Promise<void> {
  params.signal?.throwIfAborted();
  resolveCopyCloneMode(params.clone, "never");
  if (params.sourceSymlinks !== undefined && params.sourceSymlinks !== "reject" && params.sourceSymlinks !== "copy-link") {
    throw new FsSafeError("invalid-path", "sourceSymlinks must be reject or copy-link");
  }
  if (params.sourceSymlinks === "copy-link") {
    if (typeof params.source !== "string") {
      throw new FsSafeError("invalid-path", "sourceSymlinks: copy-link requires an absolute-path string source; open/stat capabilities cannot observe links without following them");
    }
    const link = await admitCopyLink(assertAbsolutePathInput(params.source), params.preserveMetadata === true, params.signal)
      .catch(error => { throw normalizePinnedWriteError(error); });
    if (link) {
      if (params.overwrite === true) throw new FsSafeError("invalid-path", "copy-link cannot overwrite an existing destination; omit overwrite or use false");
      assertCopyLinkAvailable();
      const mode = params.mode ?? (params.preserveSourceMode ? Number(link.identity.mode & 0o7777n) : undefined);
      await copyInputInRoot(root, { ...params, overwrite: false }, link, mode);
      return;
    }
  }
  const clone = resolveFileCopyCloneMode(params.clone);
  let source: OpenResult;
  let sourceIdentity: BigIntStats;
  if (typeof params.source === "string") {
    assertNoNulPathInput(params.source, "source path contains a NUL byte");
    assertNoWindowsPathAlias(params.source, "filesystem", "source path uses a Windows filesystem namespace alias");
    ({ opened: source, identity: sourceIdentity } = await openVerifiedLocalFile(params.source, {
      hardlinks: params.sourceHardlinks,
    }));
  } else {
    source = await params.source.root.open(params.source.relativePath, params.sourceHardlinks === undefined ? undefined : { hardlinks: params.sourceHardlinks });
    try {
      sourceIdentity = await inspectFileIdentity(() => fsSync.fstatSync(source.handle.fd, { bigint: true }));
    } catch (error) {
      await source.handle.close().catch(() => undefined);
      throw error;
    }
  }
  try {
    if (params.maxBytes !== undefined && source.stat.size > params.maxBytes) {
      throw new FsSafeError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${source.stat.size})`);
    }
    let metadata;
    try {
      metadata = params.preserveMetadata ? captureCopyMetadata(source.handle.fd, sourceIdentity) : undefined;
    } catch (error) {
      throw normalizePinnedWriteError(error);
    }
    const sourceAdmission = params.admitSource?.(sourceIdentity, source.realPath);
    const verifySource = async () => {
      params.signal?.throwIfAborted();
      try { sourceAdmission?.verify(); }
      catch (error) { throw new MutationAuthorityError(error); }
      if (typeof params.source !== "string") await params.source.root.stat(".");
      await assertCopySourceCurrent(source, sourceIdentity);
    };
    const mode = sourceAdmission?.mode ?? params.mode ?? (params.preserveSourceMode ? Number(sourceIdentity.mode & 0o7777n) : undefined);
    await copyInputInRoot(root, params, {
      kind: "file", handle: source.handle, size: source.stat.size, clone,
      signal: params.signal, metadata, verifySource,
    }, mode, () => assertCopySourceCurrent(source, sourceIdentity));
  } finally {
    await source.handle.close().catch(() => {});
  }
}

async function copyInputInRoot(
  root: RootContext, params: RootCopyParams,
  input: Extract<PinnedWriteInput, { kind: "file" | "link" }>, mode: number | undefined,
  verifyAdmission: () => Promise<void> = input.verifySource,
): Promise<void> {
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)) {
    throw new FsSafeError("invalid-path", "invalid copy mode");
  }
  await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
    const pinned = await resolvePinnedWriteTargetInRoot(root, params.relativePath, mode,
      params.denyMutations, params.overwrite !== false, params.mutationSymlinks);
    await serializePathWrite(pinned.targetPath, async () => {
      await verifyAdmission();
      const observer = createCopyPublicationObserver(pinned.targetPath, params.onDestinationPublished);
      try {
        await runPinnedWriteHelper({
          rootPath: pinned.rootReal, relativeParentPath: pinned.relativeParentPath, basename: pinned.basename,
          mkdir: params.mkdir !== false, mode: pinned.mode, overwrite: params.overwrite !== false,
          rejectFinalSymlink: params.mutationSymlinks !== undefined, maxBytes: params.maxBytes,
          sync: params.durable !== false,
          assertBeforeMutation: params.signal || params.assertBeforeMutation ? () => {
            if (params.signal?.aborted) throw new MutationAuthorityError(params.signal.reason);
            params.assertBeforeMutation?.();
          } : undefined,
          verifyPublished: params.verifyPublished, onPublished: observer.onPublished, input,
          rootIdentity: root.rootIdentity, mutationAdmission: pinned.mutationAdmission,
        });
      } catch (error) {
        observer.rethrowObserverFailure(error);
        if (params.signal?.aborted && error === params.signal.reason) throw error;
        if (isAlreadyExistsError(error)) throw new FsSafeError("already-exists", "copy destination already exists", { cause: error });
        throw normalizePinnedWriteError(error);
      }
      await input.verifySource();
    });
  });
}
