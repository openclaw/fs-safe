import type { PinnedWriteParams } from "./pinned-write.js";

// Internal composition hook; the descriptor is borrowed until the callback returns.
// Kept off RootCopyOptions and all public package exports.
export const onCopyPublication = Symbol("onCopyPublication");
export type CopyPublicationOptions = {
  [onCopyPublication]?: PinnedWriteParams["verifyPublished"];
};
