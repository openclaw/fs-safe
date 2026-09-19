import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { assertNoWindowsPathAlias, resolvePathPreservingWindowsRoot } from "./windows-path-alias.js";
import { sameFileIdentityForCleanup, type FileIdentityStat } from "./file-identity.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import type { NativeOwnedTreeRemovalResult } from "./native-binding.js";
import type { TempWorkspaceRootAdmission } from "./temp-workspace-admission.js";
import {
  openTempWorkspaceCleanupParent,
  TempWorkspaceRetainedChild,
  type RetainedChildDirectory,
  type RetainedDirectory,
} from "./temp-workspace-descriptor.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

export type TempWorkspaceCleanupResult = "removed" | "missing" | "identity-mismatch" | "indeterminate";
export type TempWorkspaceCleanupSafety = "compatible" | "require-bounded";

type Quarantine = { name: string; path: string; nativeRemoval: boolean };
type RemovalFailure = { readonly error: unknown };
type CleanupCapabilityPhase = "new" | "ready" | "sealed" | "failed" | "closed";

function isNativeCleanupBinding(
  binding: NativeBinding | undefined,
): binding is NativeBinding & Required<Pick<NativeBinding,
  "renameNoReplace" | "removeOwnedTree" | "removeOwnedTreeSync" | "ownedTreeRemovalAvailable">> {
  return typeof binding?.renameNoReplace === "function" &&
    typeof binding.removeOwnedTree === "function" &&
    typeof binding.removeOwnedTreeSync === "function" &&
    typeof binding.ownedTreeRemovalAvailable === "function";
}

function nativeRemovalError(result: NativeOwnedTreeRemovalResult): Error | undefined {
  if (!result.errorCode) return undefined;
  return Object.assign(new Error(result.errorMessage ?? "native owned-tree cleanup failed"), {
    code: result.errorCode,
  });
}

export class TempWorkspaceCleanupCapability {
  readonly binding: NativeBinding | undefined;
  readonly parent: RetainedDirectory | undefined;
  readonly #admission: TempWorkspaceRootAdmission;
  readonly #safety: TempWorkspaceCleanupSafety;
  readonly #ownedTreeRemovalAvailable: boolean;
  #phase: CleanupCapabilityPhase = "new";

  constructor(
    root: string,
    safety: TempWorkspaceCleanupSafety,
    admission: TempWorkspaceRootAdmission,
    dirMode: number,
  ) {
    assertNoWindowsPathAlias(root, "filesystem");
    const admittedRoot = admission.dir;
    assertNoWindowsPathAlias(admittedRoot, "filesystem");
    const resolvedRoot = resolvePathPreservingWindowsRoot(root);
    assertNoWindowsPathAlias(resolvedRoot, "filesystem");
    if (resolvedRoot !== resolvePathPreservingWindowsRoot(admittedRoot)) {
      throw new FsSafeError("path-mismatch", "temp workspace cleanup parent differs from admitted root");
    }
    this.#admission = admission;
    this.#safety = safety;
    // POSIX enumeration reopens fd-relative ".", so retaining O_RDONLY before
    // chmod cannot supply read/search authority that the final mode removes.
    const childModeAllowsRemoval = process.platform === "win32" || (dirMode & 0o500) === 0o500;
    if (safety === "require-bounded" && !childModeAllowsRemoval) {
      throw new FsSafeError(
        "helper-unavailable",
        "temp workspace owned-tree cleanup requires owner read and search in dirMode",
      );
    }
    let binding: NativeBinding | undefined;
    try {
      binding = getNativeBinding();
    } catch (error) {
      if (safety === "require-bounded") throw error;
    }
    this.binding = binding;
    let parent: RetainedDirectory | undefined;
    try {
      parent = openTempWorkspaceCleanupParent(root, admission);
    } catch (error) {
      // Failed descriptor closure must retain the original admission failure too.
      if (error instanceof AggregateError) throw error;
    }
    let available = false;
    if (childModeAllowsRemoval && parent?.access === "read" && isNativeCleanupBinding(binding)) {
      let probeReady = false;
      try {
        admission.prepareCleanupProbe(parent.fd);
        probeReady = true;
      } catch (error) {
        // A descriptor that cannot be associated even provisionally must not
        // reach native code or remain available to compatible cleanup.
        try {
          fsSync.closeSync(parent.fd);
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            "temp workspace cleanup parent probe admission and close failed",
          );
        }
        parent = undefined;
      }
      try {
        if (probeReady && parent) {
          available = binding.ownedTreeRemovalAvailable(parent.fd) === true;
        }
      } catch {
        // Runtime denial must select fallback or reject before child creation.
      }
    }
    this.parent = parent;
    this.#ownedTreeRemovalAvailable = available;
    if (safety === "require-bounded" && !this.#ownedTreeRemovalAvailable) {
      this.close();
      throw new FsSafeError(
        "helper-unavailable",
        "temp workspace owned-tree cleanup is unavailable",
      );
    }
  }

  get canRemoveOwnedTree(): boolean {
    return (this.#phase === "ready" || this.#phase === "sealed") &&
      this.#ownedTreeRemovalAvailable;
  }

  prepareChildCreation(): void {
    const replay = this.#phase === "ready";
    if (this.#phase !== "new" && !replay) {
      throw new FsSafeError("path-mismatch", "temp workspace cleanup parent is unavailable");
    }
    // A failed initial admission or receipt replay is terminal: no earlier
    // authority may survive a partial revalidation.
    this.#phase = "failed";
    if (replay) {
      if (this.parent) this.#admission.associateAncestry(this.parent.fd);
      else this.#admission.assertAncestry();
    } else {
      this.#admission.prepareChildCreation(this.parent?.fd);
    }
    // The retained descriptor cannot authorize cleanup until the complete
    // ancestry and its exact descriptor association succeeded together.
    this.#phase = "ready";
  }

  #assertCurrent(ancestry: boolean): void {
    if ((this.#phase !== "ready" && this.#phase !== "sealed") || !this.parent) {
      throw new FsSafeError("path-mismatch", "temp workspace cleanup parent is unavailable");
    }
    if (ancestry) this.#admission.associateAncestry(this.parent.fd);
    else this.#admission.associateCurrent(this.parent.fd);
  }

  admitChildDescriptor(canEnumerate: boolean): boolean {
    if (this.#phase !== "ready") {
      throw new FsSafeError("path-mismatch", "temp workspace cleanup parent is unavailable");
    }
    // From this point the capability belongs to this successfully created
    // child. Collision retries and further preparation must remain impossible.
    this.#phase = "sealed";
    const bounded = this.canRemoveOwnedTree && canEnumerate;
    if (this.#safety === "require-bounded" && !bounded) {
      throw new FsSafeError(
        "helper-unavailable",
        "temp workspace owned-tree cleanup requires a readable child descriptor",
      );
    }
    return bounded;
  }

  assertCurrent(): void {
    this.#assertCurrent(false);
  }

  assertAncestryCurrent(): void {
    this.#assertCurrent(true);
  }

  close(): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    if (this.parent) fsSync.closeSync(this.parent.fd);
  }
}

export class TempWorkspaceCleanupOwner {
  readonly #dir: string;
  readonly #identity: FileIdentityStat;
  readonly #capability: TempWorkspaceCleanupCapability;
  readonly #directory: RetainedChildDirectory | undefined;
  #closed = false;
  #running = false;
  #exitInterrupted = false;
  #result?: TempWorkspaceCleanupResult;
  #pending?: Promise<TempWorkspaceCleanupResult>;

  constructor(
    retained: TempWorkspaceRetainedChild,
    capability: TempWorkspaceCleanupCapability,
    retainDescriptor: boolean,
  ) {
    const child = retained.transfer(retainDescriptor);
    this.#dir = child.dir;
    this.#identity = child.identity;
    this.#capability = capability;
    this.#directory = child.directory;
  }

  #repeat(): TempWorkspaceCleanupResult {
    return this.#result === "removed" ? "missing" : this.#result!;
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    if (this.#directory) {
      try {
        fsSync.closeSync(this.#directory.fd);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#capability.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "temp workspace cleanup descriptor close failed");
  }

  #finish(result: TempWorkspaceCleanupResult): TempWorkspaceCleanupResult {
    this.#result ??= this.#exitInterrupted ? "indeterminate" : result;
    try {
      this.#close();
    } catch (error) {
      this.#result = "indeterminate";
      throw error;
    }
    return this.#result;
  }

  #fallbackResult(): TempWorkspaceCleanupResult {
    try {
      const current = fsSync.lstatSync(this.#dir, { bigint: true });
      return current.isDirectory() && !current.isSymbolicLink() &&
        sameFileIdentityForCleanup(current, this.#identity)
        ? "indeterminate"
        : "identity-mismatch";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "indeterminate";
    }
  }

  #prepare(): Quarantine | TempWorkspaceCleanupResult {
    const parent = this.#capability.parent;
    if (!parent) return this.#fallbackResult();
    try {
      this.#capability.assertCurrent();
      let current;
      try {
        current = fsSync.lstatSync(this.#dir, { bigint: true });
      } catch (error) {
        this.#capability.assertCurrent();
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "indeterminate";
      }
      this.#capability.assertCurrent();
      if (!current.isDirectory() || current.isSymbolicLink() ||
        !sameFileIdentityForCleanup(current, this.#identity)) {
        return "identity-mismatch";
      }
      const name = `.fs-safe-workspace-cleanup-${randomUUID()}`;
      const quarantinePath = path.join(parent.receipt.path, name);
      const nativeRemoval = this.#capability.canRemoveOwnedTree && this.#directory !== undefined;
      if (nativeRemoval) {
        this.#capability.binding!.renameNoReplace(
          parent.fd,
          path.basename(this.#dir),
          parent.fd,
          name,
        );
      } else {
        // The admitted receipt is exact and descriptor-associated. Reuse it as
        // the pre/post parent fence instead of layering a numeric guard over it.
        this.#capability.assertCurrent();
        fsSync.renameSync(this.#dir, quarantinePath);
      }
      this.#capability.assertCurrent();
      const quarantined = fsSync.lstatSync(quarantinePath, { bigint: true });
      this.#capability.assertCurrent();
      if (!quarantined.isDirectory() || quarantined.isSymbolicLink() ||
        !sameFileIdentityForCleanup(quarantined, this.#identity)) {
        return "indeterminate";
      }
      return { name, path: quarantinePath, nativeRemoval };
    } catch {
      // A failed rename can still have committed on a remote filesystem.
      return "indeterminate";
    }
  }

  #assertQuarantine(quarantine: Quarantine): void {
    const current = fsSync.lstatSync(quarantine.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() ||
      !sameFileIdentityForCleanup(current, this.#identity)) {
      throw new FsSafeError("path-mismatch", "temp workspace quarantine changed");
    }
    this.#capability.assertCurrent();
  }

  #mapRemoval(result: NativeOwnedTreeRemovalResult): TempWorkspaceCleanupResult {
    const error = nativeRemovalError(result);
    if (error) {
      if ((error as NodeJS.ErrnoException).code === "path-mismatch") return "indeterminate";
      throw error;
    }
    return result.outcome === "removed" ? "removed" : "indeterminate";
  }

  async #remove(quarantine: Quarantine): Promise<TempWorkspaceCleanupResult> {
    if (quarantine.nativeRemoval) {
      const beforeNativeRemoval = getFsSafeTestHooks()?.beforeTempWorkspaceNativeRemoval;
      if (beforeNativeRemoval) await beforeNativeRemoval(quarantine.path);
      return this.#mapRemoval(await this.#capability.binding!.removeOwnedTree!(
        this.#capability.parent!.fd,
        quarantine.name,
        this.#directory!.fd,
      ));
    }
    let removalFailure: RemovalFailure | undefined;
    try {
      this.#assertQuarantine(quarantine);
      try {
        await fs.rm(quarantine.path, { recursive: true, force: true });
      } catch (error) {
        removalFailure = { error };
        throw error;
      }
      this.#capability.assertCurrent();
      return "removed";
    } catch (error) {
      if (removalFailure !== undefined) throw removalFailure.error;
      return "indeterminate";
    }
  }

  #removeSync(quarantine: Quarantine): TempWorkspaceCleanupResult {
    if (quarantine.nativeRemoval) {
      getFsSafeTestHooks()?.beforeTempWorkspaceNativeRemovalSync?.(quarantine.path);
      return this.#mapRemoval(this.#capability.binding!.removeOwnedTreeSync!(
        this.#capability.parent!.fd,
        quarantine.name,
        this.#directory!.fd,
      ));
    }
    let removalFailure: RemovalFailure | undefined;
    try {
      this.#assertQuarantine(quarantine);
      try {
        fsSync.rmSync(quarantine.path, { recursive: true, force: true });
      } catch (error) {
        removalFailure = { error };
        throw error;
      }
      this.#capability.assertCurrent();
      return "removed";
    } catch (error) {
      if (removalFailure !== undefined) throw removalFailure.error;
      return "indeterminate";
    }
  }

  async #run(): Promise<TempWorkspaceCleanupResult> {
    let result: TempWorkspaceCleanupResult = "indeterminate";
    try {
      const prepared = this.#prepare();
      result = typeof prepared === "string" ? prepared : await this.#remove(prepared);
      return this.#finish(result);
    } finally {
      if (!this.#closed) this.#finish(result);
    }
  }

  cleanup(): Promise<TempWorkspaceCleanupResult> {
    if (this.#result) return Promise.resolve(this.#repeat());
    if (this.#pending) return this.#pending.then(() => this.#repeat());
    this.#running = true;
    this.#pending = this.#run();
    return this.#pending;
  }

  cleanupSync(): TempWorkspaceCleanupResult {
    if (this.#result) return this.#repeat();
    if (this.#running) {
      this.#exitInterrupted = true;
      return "indeterminate";
    }
    this.#running = true;
    let result: TempWorkspaceCleanupResult = "indeterminate";
    try {
      const prepared = this.#prepare();
      result = typeof prepared === "string" ? prepared : this.#removeSync(prepared);
      return this.#finish(result);
    } finally {
      if (!this.#closed) this.#finish(result);
    }
  }
}
