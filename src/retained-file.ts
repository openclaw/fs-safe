import { getNativeBinding } from "./native.js";
import type { NativeRetainedFile } from "./native-binding.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import type {
  RetainedFile, RetainedFileAdmission, RetainedFileReceipt, RetainedFileResult,
  RetainFileInDirectoryOptions,
} from "./retained-file-types.js";

function freeze(result: RetainedFileResult): RetainedFileResult {
  return Object.freeze({ ...result, errors: Object.freeze(result.errors.map((error) => Object.freeze({ ...error }))) });
}

function unsupported(cause?: unknown): RetainedFileResult {
  return freeze({ status: "unsupported", phase: "admission", disposition: "not-attempted",
    namespace: "not-observed", resources: "closed", persistence: "not-proven",
    errors: [{ phase: "admission", code: "helper-unavailable",
      message: "existing-file retention requires the maintained Windows native capability", cause }] });
}

function exact(value: bigint, name: string, zero = false): bigint {
  if (typeof value !== "bigint" || value < (zero ? 0n : 1n) || value > 0xffffffffffffffffn) {
    throw new TypeError(`${name} must be an exact ${zero ? "nonnegative" : "positive"} unsigned 64-bit bigint`);
  }
  return value;
}

class Owner implements RetainedFile {
  readonly receipt: RetainedFileReceipt;
  readonly #native: NativeRetainedFile;
  readonly #assert: () => void;
  #result?: RetainedFileResult;
  #running = false;
  #reentered = false;

  constructor(native: NativeRetainedFile, receipt: RetainedFileReceipt, assertion: () => void) {
    this.#native = native;
    this.receipt = receipt;
    this.#assert = assertion;
    Object.freeze(this);
  }

  #settle(remove: boolean): RetainedFileResult {
    if (this.#result) return this.#result;
    if (this.#running) {
      this.#reentered = true;
      throw new TypeError("retained-file settlement cannot be reentered");
    }
    this.#running = true;
    let rejection: { cause: unknown } | undefined;
    if (remove) {
      try {
        assertSynchronousCallbackResult(this.#assert(), "assertBeforeMutation");
        if (this.#reentered) throw new TypeError("retained-file authority reentered settlement");
      } catch (cause) { rejection = { cause }; }
    }
    try {
      const result = this.#native.settle(remove && !rejection);
      this.#result = freeze(rejection ? { ...result, phase: "authority", errors: [
        { phase: "authority", code: "denied-path", message: "current mutation authority rejected removal", cause: rejection.cause },
        ...result.errors,
      ] } : result);
    } catch (cause) {
      // An unexpected binding exception cannot establish native effect or close.
      // Do not retry or release a dependency on an unknown native outcome.
      this.#result = freeze({ status: "indeterminate", phase: "binding", identity: this.receipt.identity,
        disposition: remove && !rejection ? "indeterminate" : "not-attempted", namespace: "unknown",
        resources: "close-failed", persistence: "not-proven", errors: [
          ...(rejection ? [{ phase: "authority", code: "denied-path", message: "current mutation authority rejected removal", cause: rejection.cause }] : []),
          { phase: "binding", code: "helper-failed", message: "native settlement did not return a result", cause },
        ] });
    }
    return this.#result;
  }

  remove(): RetainedFileResult { return this.#settle(true); }
  dispose(): RetainedFileResult { return this.#settle(false); }
  [Symbol.dispose](): void { this.dispose(); }
}

/** Retain one existing regular file on supported local Windows NTFS. No fallback. */
export function retainFileInDirectory(options: RetainFileInDirectoryOptions): RetainedFileAdmission {
  // Snapshot once before any native resource admission or caller authority runs.
  const directory = options.directory;
  const basename = options.basename;
  const sourceParent = options.parent;
  const parent = Object.freeze({ dev: exact(sourceParent.dev, "parent.dev"), ino: exact(sourceParent.ino, "parent.ino") });
  const source = options.expected;
  const expected = Object.freeze({ dev: exact(source.dev, "expected.dev"), ino: exact(source.ino, "expected.ino"),
    size: exact(source.size, "expected.size", true), mtimeNs: exact(source.mtimeNs, "expected.mtimeNs", true),
    ctimeNs: exact(source.ctimeNs, "expected.ctimeNs", true), sha256: source.sha256 });
  const assertion = options.assertBeforeMutation;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (typeof directory !== "string" || typeof basename !== "string" || typeof assertion !== "function"
    || typeof expected.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expected.sha256)
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024 || expected.size > BigInt(maxBytes)) {
    throw new TypeError("invalid retained-file directory, authority or bounded expected-byte contract");
  }
  if (process.platform !== "win32") return unsupported();
  let binding;
  try { binding = getNativeBinding(); } catch (cause) { return unsupported(cause); }
  if (!binding?.retainWindowsFile) return unsupported();
  let native: NativeRetainedFile;
  try {
    native = binding.retainWindowsFile(directory, basename, parent.dev, parent.ino,
      expected.dev, expected.ino, expected.size, expected.mtimeNs, expected.ctimeNs, expected.sha256, maxBytes);
  } catch (cause) {
    // Factory errors have no returned owner; never infer absence or deletion.
    return freeze({ ...unsupported(cause), status: "indeterminate", resources: "close-failed" });
  }
  const admission = native.admission;
  if (admission.status !== "retained") return freeze(admission);
  const receipt = Object.freeze({ directory, parent, basename, expected, identity: admission.identity });
  return Object.freeze({ status: "retained", file: new Owner(native, receipt, assertion) });
}
