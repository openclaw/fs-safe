import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { captureNativeFdClose, type NativeBinding } from "./native-binding.js";
import { requireNativeBinding } from "./native.js";
import { realpathSync } from "./realpath.js";
import { describeStagedDirectory, assertStagedDirectoryCurrent } from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import type {
  EntryPublicationIssue, EntryPublicationReceipt, EntryPublicationResult,
  PublicationIdentity, PublicationParent, RetainedEntryPublication, RetainEntryForPublicationOptions,
} from "./entry-publication-types.js";

type Binding = NativeBinding & Required<Pick<NativeBinding,
  "entryPublicationFilesystem" | "publishRetainedEntryNoReplace">>;
type Directory = { fd: number; receipt: ReturnType<typeof describeStagedDirectory> };

function basename(name: string): string {
  if (typeof name !== "string" || !name || name === "." || name === ".." ||
      /[/\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) {
    throw new FsSafeError("invalid-path", "publication requires a direct-child basename");
  }
  return name;
}
function identity(value: PublicationIdentity): PublicationIdentity {
  const { dev, ino } = value;
  if (typeof dev !== "bigint" || typeof ino !== "bigint" || dev < 0n || ino <= 0n ||
      dev > 0xffffffffffffffffn || ino > 0xffffffffffffffffn) {
    throw new FsSafeError("path-mismatch", "publication requires an exact known identity");
  }
  return Object.freeze({ dev, ino });
}
function parent(value: PublicationParent): PublicationParent {
  const pathname = value.path;
  const expected = identity(value.identity);
  if (typeof pathname !== "string" || !path.isAbsolute(pathname) || path.resolve(pathname) !== pathname ||
      realpathSync.native(pathname) !== pathname) {
    throw new FsSafeError("path-alias", "publication parent must use its canonical physical spelling");
  }
  assertDirectoryIdentitySync(pathname, { ...expected, realPath: pathname });
  return Object.freeze({ path: pathname, identity: expected });
}
function retainParent(expected: PublicationParent, closes: (() => void)[]): Directory {
  const fd = fs.openSync(expected.path,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  // Register immediately: outer admission owns *all* close outcomes, including
  // failures in the shared guard. A hidden admission close cannot report closed.
  closes.push(() => fs.closeSync(fd));
  const receipt = describeStagedDirectory(fd, expected.path);
  inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }), expected.identity);
  return { fd, receipt };
}

function assertKind(stat: BigIntStats, kind: "file" | "directory"): void {
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new FsSafeError("not-file", "publication source must be the expected regular file or directory");
  }
  if (kind === "file" && stat.nlink !== 1n) {
    throw new FsSafeError("hardlink", "publication does not admit hardlinked files");
  }
}
function inspectEntry(name: string, expected: EntryPublicationReceipt["source"]["expected"]): void {
  const stat = inspectFileIdentitySync(() => fs.lstatSync(name, { bigint: true }), expected);
  assertKind(stat, expected.kind);
  if (realpathSync.native(name) !== name) {
    throw new FsSafeError("path-alias", "publication source must use its canonical physical spelling");
  }
}
function settle(closes: (() => void)[], issues: EntryPublicationIssue[]): EntryPublicationResult["resources"] {
  let resources: EntryPublicationResult["resources"] = "closed";
  // Consume ownership before each close; a failed close must never be retried.
  for (const close of closes.splice(0).reverse()) {
    try { close(); }
    catch (cause) { resources = "close-failed"; issues.push(Object.freeze({ phase: "close", cause })); }
  }
  return resources;
}

class Publication implements RetainedEntryPublication {
  #result?: EntryPublicationResult;
  #busy = false;
  readonly #receipt: EntryPublicationReceipt;
  readonly #binding: Binding;
  readonly #sourceParent: Directory;
  readonly #destinationParent: Directory;
  readonly #sourceFd: number;
  readonly #closes: (() => void)[];
  readonly #assertion: () => void;
  constructor(receipt: EntryPublicationReceipt, binding: Binding, sourceParent: Directory,
    destinationParent: Directory, sourceFd: number, closes: (() => void)[], assertion: () => void) {
    this.#receipt = receipt;
    this.#binding = binding;
    this.#sourceParent = sourceParent;
    this.#destinationParent = destinationParent;
    this.#sourceFd = sourceFd;
    this.#closes = closes;
    this.#assertion = assertion;
  }
  get receipt(): EntryPublicationReceipt { return this.#receipt; }

  #idle(): void {
    if (this.#busy) throw new FsSafeError("helper-failed", "reentrant entry publication");
  }
  #current(published = false): void {
    assertStagedDirectoryCurrent(this.#sourceParent.receipt);
    assertStagedDirectoryCurrent(this.#destinationParent.receipt);
    const expected = this.receipt.source.expected;
    assertKind(inspectFileIdentitySync(() => fs.fstatSync(this.#sourceFd, { bigint: true }), expected), expected.kind);
    const location = published ? this.receipt.destination : this.receipt.source;
    inspectEntry(path.join(location.parent.path, location.basename), expected);
  }
  publish(): EntryPublicationResult {
    this.#idle();
    if (this.#result) return this.#result;
    this.#busy = true;
    let transition: EntryPublicationResult["transition"] = "not-published";
    let verification: EntryPublicationResult["verification"] = "not-performed";
    let phase: EntryPublicationIssue["phase"] = "authority";
    const issues: EntryPublicationIssue[] = [];
    try {
      assertSynchronousCallbackResult(this.#assertion(), "assertBeforeMutation");
      phase = "precheck";
      this.#current();
      phase = "native";
      // Any thrown/lost/malformed native reply is unknown, even if a later path
      // observation happens to resemble success or failure.
      transition = "indeterminate";
      const native = this.#binding.publishRetainedEntryNoReplace(
        this.#sourceParent.fd, this.receipt.source.basename, this.#sourceFd,
        this.#destinationParent.fd, this.receipt.destination.basename,
      );
      if (native?.outcome !== "committed" && native?.outcome !== "not-published" && native?.outcome !== "indeterminate") {
        throw new FsSafeError("helper-failed", "native publication returned an unknown outcome");
      }
      transition = native.outcome; // Capture BEFORE diagnostics, observations or close.
      if (native.errorCode || transition !== "committed") {
        throw Object.assign(new Error(native.errorMessage ?? "entry publication did not commit"),
          { code: native.errorCode ?? "helper-failed" });
      }
      phase = "postcheck";
      verification = "failed";
      this.#current(true);
      verification = "verified";
    } catch (cause) { issues.push(Object.freeze({ phase, cause })); }
    const resources = settle(this.#closes, issues);
    this.#result = Object.freeze({ transition, verification, resources, issues: Object.freeze(issues) });
    this.#busy = false;
    return this.#result;
  }
  dispose(): EntryPublicationResult {
    this.#idle();
    if (this.#result) return this.#result;
    this.#busy = true;
    const issues: EntryPublicationIssue[] = [];
    const resources = settle(this.#closes, issues);
    this.#result = Object.freeze({ transition: "not-published", verification: "not-performed",
      resources, issues: Object.freeze(issues) });
    this.#busy = false;
    return this.#result;
  }
  [Symbol.dispose](): void {
    const result = this.dispose();
    if (result.resources === "close-failed") {
      throw new FsSafeError("helper-failed", "entry publication descriptor close failed", {
        cause: result.issues[0]?.cause, details: { result },
      });
    }
  }
}

/**
 * Retain an existing directory or single-link regular file for ONE-WAY export.
 * Requires caller-exclusive source namespace and stable admitted topology.
 * Native destination absence is atomic; POSIX source identity is NOT CAS.
 * All operation results settle descriptors, never delete or reverse names.
 */
export function retainEntryForPublication(options: RetainEntryForPublicationOptions): RetainedEntryPublication {
  const closes: (() => void)[] = [];
  try {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new FsSafeError("unsupported-platform", "entry publication requires macOS or Linux");
    }
    const native = requireNativeBinding();
    if (typeof native.entryPublicationFilesystem !== "function" ||
        typeof native.publishRetainedEntryNoReplace !== "function" || typeof native.openBeneath !== "function") {
      throw new FsSafeError("helper-unavailable", "native entry publication is unavailable");
    }
    const binding = native as Binding;
    const closeSource = captureNativeFdClose(binding);
    const assertion = options.assertBeforeMutation;
    if (typeof assertion !== "function") throw new FsSafeError("invalid-path", "synchronous publication authority is required");
    const kind = options.source.expected.kind;
    if (kind !== "directory" && kind !== "file") throw new FsSafeError("not-file", "unsupported publication entry kind");
    const source = Object.freeze({ parent: parent(options.source.parent), basename: basename(options.source.basename),
      expected: Object.freeze({ ...identity(options.source.expected), kind }) });
    const destination = Object.freeze({ parent: parent(options.destination.parent), basename: basename(options.destination.basename) });
    const sourcePath = path.join(source.parent.path, source.basename);
    const targetPath = path.join(destination.parent.path, destination.basename);
    if (targetPath === sourcePath || (kind === "directory" && targetPath.startsWith(`${sourcePath}${path.sep}`))) {
      throw new FsSafeError("invalid-path", "publication source and destination overlap");
    }
    const sourceParent = retainParent(source.parent, closes);
    const destinationParent = retainParent(destination.parent, closes);
    const sourceFilesystem = binding.entryPublicationFilesystem(sourceParent.fd);
    const destinationFilesystem = binding.entryPublicationFilesystem(destinationParent.fd);
    if (source.expected.dev !== source.parent.identity.dev || source.expected.dev !== destination.parent.identity.dev) {
      throw Object.assign(new Error("entry publication cannot cross devices"), { code: "EXDEV" });
    }
    inspectEntry(sourcePath, source.expected);
    const opened = binding.openBeneath(sourceParent.fd, source.basename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
      (kind === "directory" ? fs.constants.O_DIRECTORY : 0));
    if (!opened || !Number.isInteger(opened.fd) || opened.fd < 0) {
      throw new FsSafeError("helper-unavailable", "publication source descriptor is unavailable");
    }
    closes.push(() => closeSource(opened.fd));
    assertKind(inspectFileIdentitySync(() => fs.fstatSync(opened.fd, { bigint: true }), source.expected), kind);
    inspectEntry(sourcePath, source.expected);
    assertStagedDirectoryCurrent(sourceParent.receipt);
    assertStagedDirectoryCurrent(destinationParent.receipt);
    const receipt: EntryPublicationReceipt = Object.freeze({ source, destination, capability: Object.freeze({
      destinationAbsence: "atomic", sourceIdentity: "observed-under-caller-exclusive-namespace",
      parentBinding: "retained-object", sourceFilesystem, destinationFilesystem,
    }) });
    return new Publication(receipt, binding, sourceParent, destinationParent, opened.fd, closes, assertion);
  } catch (cause) {
    const issues: EntryPublicationIssue[] = [Object.freeze({ phase: "admission", cause })];
    const resources = settle(closes, issues);
    const result: EntryPublicationResult = Object.freeze({ transition: "not-published", verification: "not-performed",
      resources, issues: Object.freeze(issues) });
    throw new FsSafeError(cause instanceof FsSafeError ? cause.code : "helper-failed", "entry publication admission failed", {
      cause, details: { result },
    });
  }
}
