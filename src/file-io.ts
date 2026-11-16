export {
  copyRootFileSync,
  createRootFileCopyBatchSync,
  type RootFileCopyBatchSync,
  type CopyRootFileSyncOptions,
  type CopiedRootFileSync,
} from "./copy-root-file-sync.js";
export { copyFileHandle, copyFileDescriptorSync, type CopyFileHandleOptions } from "./file-handle-transfer.js";
export {
  readFileDescriptorBounded,
  readFileDescriptorBoundedSync,
  readFileHandleBounded,
} from "./bounded-read.js";
export {
  readFileWindowFully,
  readFileWindowFullySync,
  type ReadFileWindowOptions,
} from "./positional-read.js";
export { writeFileWindowFully, type WriteFileWindowOptions } from "./write-file-handle.js";
export {
  openRootFile,
  openRootFileSync,
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  type OpenRootFileParams,
  type OpenRootFileSyncParams,
  type RootFileOpenFailure,
  type RootFileOpenFailureReason,
  type RootFileOpenResult,
} from "./root-file.js";
export { createRootFileOpenBatchSync, type RootFileOpenBatchSync } from "./root-file-open-batch-sync.js";
