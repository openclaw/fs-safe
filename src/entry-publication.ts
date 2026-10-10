import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { noReplaceUnavailable } from "./native-noreplace.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { captureNativeFdClose, type NativeBinding, type NativeWindowsEntryPublication, type NativePublicationTransition } from "./native-binding.js";
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
type Close = () => void | readonly unknown[];
type Backend = { current(published: boolean): void; publish(): NativePublicationTransition };
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
function retainParent(expected: PublicationParent, closes: Close[]): Directory {
  const fd = fs.openSync(expected.path,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  // Register immediately: outer admission owns *all* close outcomes, including
  // failures in the shared guard. A hidden admission close cannot report closed.
  closes.push(() => fs.closeSync(fd));
  const receipt = describeStagedDirectory(fd, expected.path);
  inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }), expected.identity);
  return { fd, receipt };
}

function assertKind(stat: BigIntStats, kind: EntryPublicationReceipt["source"]["expected"]["kind"]): void {
  if (kind === "file" ? !stat.isFile() : kind === "symlink" ? !stat.isSymbolicLink() : !stat.isDirectory()) {
    throw new FsSafeError("not-file", "publication source must be the expected file, directory or symlink");
  }
  if (kind !== "directory" && stat.nlink !== 1n) {
    throw new FsSafeError("hardlink", "publication does not admit hardlinked files or symlinks");
  }
}
function inspectEntry(name: string, expected: EntryPublicationReceipt["source"]["expected"]): void {
  const stat = inspectFileIdentitySync(() => fs.lstatSync(name, { bigint: true }), expected);
  assertKind(stat, expected.kind);
  // A symlink target is opaque: it may be dangling, relative or inaccessible.
  // Check the directory entry spelling without resolving or opening the target.
  const canonical = expected.kind === "symlink"
    ? fs.readdirSync(path.dirname(name)).includes(path.basename(name))
    : realpathSync.native(name) === name;
  if (!canonical) {
    throw new FsSafeError("path-alias", "publication source must use its canonical physical spelling");
  }
}
function settle(closes: Close[], issues: EntryPublicationIssue[]): EntryPublicationResult["resources"] {
  let resources: EntryPublicationResult["resources"] = "closed";
  // Consume ownership before each close; a failed close must never be retried.
  for (const close of closes.splice(0).reverse()) {
    try {
      for (const cause of close() ?? []) { resources = "close-failed"; issues.push(Object.freeze({ phase: "close", cause })); }
    }
    catch (cause) { resources = "close-failed"; issues.push(Object.freeze({ phase: "close", cause })); }
  }
  return resources;
}

class Publication implements RetainedEntryPublication {
  #result?: EntryPublicationResult;
  #busy = false;
  readonly #receipt: EntryPublicationReceipt;
  readonly #backend: Backend;
  readonly #closes: Close[];
  readonly #assertion: () => void;
  constructor(receipt: EntryPublicationReceipt, backend: Backend, closes: Close[], assertion: () => void) {
    this.#receipt = receipt;
    this.#backend = backend;
    this.#closes = closes;
    this.#assertion = assertion;
  }
  get receipt(): EntryPublicationReceipt { return this.#receipt; }

  #idle(): void {
    if (this.#busy) throw new FsSafeError("helper-failed", "reentrant entry publication");
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
      this.#backend.current(false);
      phase = "native";
      // Any thrown/lost/malformed native reply is unknown, even if a later path
      // observation happens to resemble success or failure.
      transition = "indeterminate";
      const native = this.#backend.publish();
      if (native?.outcome !== "committed" && native?.outcome !== "not-published" && native?.outcome !== "indeterminate") {
        throw new FsSafeError("helper-failed", "native publication returned an unknown outcome");
      }
      transition = native.outcome; // Capture BEFORE diagnostics, observations or close.
      if (native.errorCode || transition !== "committed") {
        const error = Object.assign(new Error(native.errorMessage ?? "entry publication did not commit"),
          { code: native.errorCode ?? "helper-failed" });
        throw noReplaceUnavailable(error, "retained entry publication") ?? error;
      }
      phase = "postcheck";
      verification = "failed";
      this.#backend.current(true);
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

function publicationReceipt(source: EntryPublicationReceipt["source"], destination: EntryPublicationReceipt["destination"],
  sourceFilesystem: string, destinationFilesystem: string): EntryPublicationReceipt {
  return Object.freeze({ source, destination, capability: Object.freeze({ destinationAbsence: "atomic",
    sourceIdentity: "observed-under-caller-exclusive-namespace", parentBinding: "retained-object", sourceFilesystem, destinationFilesystem }) });
}

/**
 * Retain an existing directory, single-link regular file or symlink for ONE-WAY export.
 * Requires caller-exclusive source namespace and stable admitted topology.
 * Native destination absence is atomic; POSIX source identity is NOT CAS.
 * All operation results settle descriptors, never delete or reverse names.
 */
export function retainEntryForPublication(options: RetainEntryForPublicationOptions): RetainedEntryPublication {
  const closes: Close[] = [];
  try {
    if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
      throw new FsSafeError("unsupported-platform", "entry publication requires macOS, Linux or Windows");
    }
    const native = requireNativeBinding();
    const assertion = options.assertBeforeMutation;
    if (typeof assertion !== "function") throw new FsSafeError("invalid-path", "synchronous publication authority is required");
    const kind = options.source.expected.kind;
    if (kind !== "directory" && kind !== "file" && kind !== "symlink") throw new FsSafeError("not-file", "unsupported publication entry kind");
    const source = Object.freeze({ parent: parent(options.source.parent), basename: basename(options.source.basename),
      expected: Object.freeze({ ...identity(options.source.expected), kind }) });
    const destination = Object.freeze({ parent: parent(options.destination.parent), basename: basename(options.destination.basename) });
    const sourcePath = path.join(source.parent.path, source.basename);
    const targetPath = path.join(destination.parent.path, destination.basename);
    if (targetPath === sourcePath || (kind === "directory" && targetPath.startsWith(`${sourcePath}${path.sep}`))) {
      throw new FsSafeError("invalid-path", "publication source and destination overlap");
    }
    if (process.platform === "win32") {
      if (typeof native.retainWindowsEntryPublication !== "function") {
        throw new FsSafeError("helper-unavailable", "native Windows entry retention is unavailable");
      }
      inspectEntry(sourcePath, source.expected);
      let owner: NativeWindowsEntryPublication | undefined;
      // A lost admission reply cannot prove resource settlement. The native GC
      // backstop closes only; an explicit unknown close must remain visible.
      closes.push(() => {
        if (!owner) throw new FsSafeError("helper-failed", "native retention reply lost; closure unknown");
        return owner.close().map(error => Object.assign(new Error(error.message), { code: error.code }));
      });
      owner = native.retainWindowsEntryPublication(source.parent.path, source.basename, source.parent.identity.dev, source.parent.identity.ino,
        destination.parent.path, destination.basename, destination.parent.identity.dev, destination.parent.identity.ino,
        source.expected.dev, source.expected.ino, kind);
      const admitted = owner.admission;
      if (admitted.outcome !== "retained" || admitted.errorCode) {
        throw Object.assign(new Error(admitted.errorMessage ?? "native Windows publication admission failed"), { code: admitted.errorCode ?? "helper-failed" });
      }
      const retained = owner;
      const receipt = publicationReceipt(source, destination, "ntfs", "ntfs");
      return new Publication(receipt, { current: published => retained.current(published), publish: () => retained.publish() }, closes, assertion);
    }
    if (typeof native.entryPublicationFilesystem !== "function" ||
        typeof native.publishRetainedEntryNoReplace !== "function" || typeof native.openBeneath !== "function") {
      throw new FsSafeError("helper-unavailable", "native entry publication is unavailable");
    }
    const binding = native as Binding;
    const closeSource = captureNativeFdClose(binding);
    if (kind === "symlink" && typeof binding.openStagedSymlink !== "function") {
      throw new FsSafeError("helper-unavailable", "native symlink retention is unavailable");
    }
    const sourceParent = retainParent(source.parent, closes);
    const destinationParent = retainParent(destination.parent, closes);
    const sourceFilesystem = binding.entryPublicationFilesystem(sourceParent.fd);
    const destinationFilesystem = binding.entryPublicationFilesystem(destinationParent.fd);
    if (source.expected.dev !== source.parent.identity.dev || source.expected.dev !== destination.parent.identity.dev) {
      throw Object.assign(new Error("entry publication cannot cross devices"), { code: "EXDEV" });
    }
    inspectEntry(sourcePath, source.expected);
    const sourceFd = kind === "symlink"
      ? binding.openStagedSymlink!(sourceParent.fd, source.basename)
      : native.openBeneath(sourceParent.fd, source.basename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
      (kind === "directory" ? fs.constants.O_DIRECTORY : 0))?.fd;
    if (!Number.isInteger(sourceFd) || sourceFd < 0) {
      throw new FsSafeError("helper-unavailable", "publication source descriptor is unavailable");
    }
    closes.push(() => closeSource(sourceFd));
    assertKind(inspectFileIdentitySync(() => fs.fstatSync(sourceFd, { bigint: true }), source.expected), kind);
    inspectEntry(sourcePath, source.expected);
    assertStagedDirectoryCurrent(sourceParent.receipt);
    assertStagedDirectoryCurrent(destinationParent.receipt);
    const receipt = publicationReceipt(source, destination, sourceFilesystem, destinationFilesystem);
    return new Publication(receipt, {
      current(published) {
        assertStagedDirectoryCurrent(sourceParent.receipt);
        assertStagedDirectoryCurrent(destinationParent.receipt);
        assertKind(inspectFileIdentitySync(() => fs.fstatSync(sourceFd, { bigint: true }), source.expected), kind);
        const location = published ? destination : source;
        inspectEntry(path.join(location.parent.path, location.basename), source.expected);
      },
      publish: () => binding.publishRetainedEntryNoReplace(sourceParent.fd, source.basename, sourceFd, destinationParent.fd, destination.basename),
    }, closes, assertion);
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
