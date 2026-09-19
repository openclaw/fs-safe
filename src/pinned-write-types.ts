import type { CopyFileInput } from "./copy-file-input.js";
import type { AnyAsyncDirectoryGuard } from "./directory-guard.js";
import type { FileIdentityStat } from "./file-identity.js";
import type { MutationDirectoryObservation } from "./pinned-mutation-observation.js";

export type PinnedWriteInput =
  | { kind: "buffer"; data: string | Buffer; encoding?: BufferEncoding; stageBeforePublish?: boolean }
  | { kind: "stream"; stream: AsyncIterable<Uint8Array | string>; stageBeforePublish?: boolean }
  | CopyFileInput;

export type RenameIdentityPolicy = "strict" | "verify-content-with-lock";

export type PublishedWriteIdentity = Readonly<{ dev: bigint; ino: bigint }>;

// Opaque operation-local proof that the immediately preceding parent-create
// admission belongs to the epoch a directory walk is advancing.
export type PinnedMutationAdmissionReceipt = Readonly<object>;

// Opaque operation-local proof that a synchronous, guard-bound authorization
// completed without crossing an await boundary.
export type PinnedMutationAuthorizationToken = Readonly<object>;

// Full post-create facts paired with the exact admission that authorized the
// mkdir. Every nested object is frozen before it reaches the epoch updater.
export type PinnedCreatedDirectoryReceipt = Readonly<{
  admission: PinnedMutationAdmissionReceipt;
  parent: MutationDirectoryObservation;
  child: MutationDirectoryObservation;
}>;

export type PinnedMutationParentWalkSession = Readonly<{
  retainedTargetPath: string;
  tryAuthorizeAtParent(request: Readonly<{
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  }>, parent: MutationDirectoryObservation): PinnedMutationAuthorizationToken | undefined;
  authorize(request: Readonly<{
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  }>): Promise<PinnedMutationAdmissionReceipt | undefined>;
  advanceCreatedDirectory(
    receipt: PinnedCreatedDirectoryReceipt,
  ): PinnedMutationAuthorizationToken | undefined;
  dispose(): void;
}>;

export type PinnedWriteMutationAdmission = Readonly<{
  rejectParentSymlinks: boolean;
  beginParentWalk?(): string | undefined;
  beginSharedParentWalk?(): PinnedMutationParentWalkSession | undefined;
  beginNativeParentWalk?(): PinnedMutationParentWalkSession | undefined;
  tryAuthorizeAtParent?(request: Readonly<{
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  }>, parent: MutationDirectoryObservation): PinnedMutationAuthorizationToken | undefined;
  authorize(request: Readonly<{
    targetPath: string;
    mutationPath: string;
    phase: "parent" | "parent-create";
  }>): Promise<PinnedMutationAdmissionReceipt | undefined>;
  advanceCreatedDirectory?(
    receipt: PinnedCreatedDirectoryReceipt,
  ): PinnedMutationAuthorizationToken | undefined;
}>;

export type PinnedWriteParams = {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  private?: boolean;
  // Secret writers require verified POSIX modes without private-creation ACL policy.
  verifyPosixMode?: boolean;
  sync?: boolean;
  strictFileSync?: boolean;
  overwrite?: boolean;
  assertBeforeMutation?: () => void;
  rejectFinalSymlink?: boolean;
  maxBytes?: number;
  input: PinnedWriteInput;
  rootIdentity?: FileIdentityStat;
  mutationAdmission?: PinnedWriteMutationAdmission;
  onRenameIdentityMismatch?: "verify-content";
  onPublished?: (identity: PublishedWriteIdentity) => void;
  // Borrowed only for this callback; the writer closes every descriptor in finally.
  verifyPublished?: (
    fd: number,
    identity: PublishedWriteIdentity,
    parentGuard: AnyAsyncDirectoryGuard,
  ) => Promise<void>;
};
