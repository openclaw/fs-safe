import { ownFileDescriptorSync, type OwnedFileDescriptorSync } from "./create-owned-file.js";
import { FsSafeError } from "./errors.js";
import { captureNativeFdClose } from "./native-binding.js";
import { requireNativeBinding } from "./native.js";

export type OwnedPipeSync = {
  readonly reader: OwnedFileDescriptorSync;
  readonly writer: OwnedFileDescriptorSync;
  /** True when close-on-exec was set atomically at creation. */
  readonly atomicCloseOnExec: boolean;
};

/** Creates a POSIX anonymous pipe with two native-owned, close-on-exec ends. */
export function createPipe(): OwnedPipeSync {
  if (!["linux", "darwin", "freebsd"].includes(process.platform)) {
    throw new FsSafeError("unsupported-platform", "anonymous pipes require Linux, Darwin, or FreeBSD");
  }
  const native = requireNativeBinding();
  if (!native.createPipe) {
    throw new FsSafeError("helper-unavailable", "native anonymous pipes are unavailable");
  }
  const close = captureNativeFdClose(native);
  try {
    const { reader, writer, atomicCloseOnExec } = native.createPipe();
    return Object.freeze({
      reader: ownFileDescriptorSync(reader, close),
      writer: ownFileDescriptorSync(writer, close),
      atomicCloseOnExec,
    });
  } catch (cause) {
    throw new FsSafeError("helper-failed", "anonymous pipe creation failed", { cause });
  }
}
