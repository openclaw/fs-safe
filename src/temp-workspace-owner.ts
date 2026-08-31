import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createAsyncDirectoryGuard, createSyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup, type FileIdentityStat } from "./file-identity.js";
import { withAsyncDirectoryGuards, withSyncDirectoryGuards } from "./guarded-mutation.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import type { NativeOwnedTreeRemovalResult } from "./native-binding.js";
import { assertStagedDirectoryCurrent, openStagedDirectory } from "./staged-directory.js";

export type TempWorkspaceCleanupResult = "removed" | "missing" | "identity-mismatch" | "indeterminate";
export type TempWorkspaceCleanupSafety = "compatible" | "require-bounded";

type RetainedDirectory = ReturnType<typeof openStagedDirectory>;
type Quarantine = { name: string; path: string; nativeRemoval: boolean };

function isNativeCleanupBinding(
  binding: NativeBinding | undefined,
): binding is NativeBinding & Required<Pick<NativeBinding,
  "removeOwnedTree" | "removeOwnedTreeSync">> {
  return typeof binding?.renameNoReplace === "function" &&
    typeof binding.removeOwnedTree === "function" &&
    typeof binding.removeOwnedTreeSync === "function";
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
  #closed = false;

  constructor(root: string, safety: TempWorkspaceCleanupSafety) {
    let binding: NativeBinding | undefined;
    try {
      binding = getNativeBinding();
    } catch (error) {
      if (safety === "require-bounded") throw error;
    }
    this.binding = binding;
    let parent: RetainedDirectory | undefined;
    try {
      parent = openStagedDirectory(root);
      assertStagedDirectoryCurrent(parent.receipt);
    } catch {
      if (parent) fsSync.closeSync(parent.fd);
    }
    this.parent = parent;
    if (safety === "require-bounded" && (!parent || !isNativeCleanupBinding(this.binding))) {
      this.close();
      throw new FsSafeError(
        "helper-unavailable",
        "temp workspace owned-tree cleanup is unavailable",
      );
    }
  }

  get canRemoveOwnedTree(): boolean {
    return !this.#closed && this.parent !== undefined && isNativeCleanupBinding(this.binding);
  }

  assertCurrent(): void {
    if (this.#closed || !this.parent) {
      throw new FsSafeError("path-mismatch", "temp workspace cleanup parent is unavailable");
    }
    assertStagedDirectoryCurrent(this.parent.receipt);
    const current = fsSync.fstatSync(this.parent.fd, { bigint: true });
    if (!sameFileIdentityForCleanup(current, this.parent.receipt.identity)) {
      throw new FsSafeError("path-mismatch", "temp workspace cleanup parent changed");
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.parent) fsSync.closeSync(this.parent.fd);
  }
}

export class TempWorkspaceCleanupOwner {
  readonly #dir: string;
  readonly #identity: FileIdentityStat;
  readonly #capability: TempWorkspaceCleanupCapability;
  readonly #directory: RetainedDirectory | undefined;
  #closed = false;
  #running = false;
  #exitInterrupted = false;
  #result?: TempWorkspaceCleanupResult;
  #pending?: Promise<TempWorkspaceCleanupResult>;

  constructor(dir: string, identity: FileIdentityStat, capability: TempWorkspaceCleanupCapability) {
    this.#dir = dir;
    this.#identity = { dev: identity.dev, ino: identity.ino };
    this.#capability = capability;
    let directory: RetainedDirectory | undefined;
    if (capability.canRemoveOwnedTree) {
      directory = openStagedDirectory(dir);
      const current = fsSync.fstatSync(directory.fd, { bigint: true });
      if (!sameFileIdentityForCleanup(current, this.#identity)) {
        fsSync.closeSync(directory.fd);
        capability.close();
        throw new FsSafeError("path-mismatch", "temp workspace changed while retaining cleanup authority");
      }
    }
    this.#directory = directory;
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
      if (typeof this.#capability.binding?.renameNoReplace === "function") {
        this.#capability.binding.renameNoReplace(
          parent.fd,
          path.basename(this.#dir),
          parent.fd,
          name,
        );
      } else {
        const guard = createSyncDirectoryGuard(parent.receipt.path);
        withSyncDirectoryGuards([guard], () => {
          this.#capability.assertCurrent();
          fsSync.renameSync(this.#dir, quarantinePath);
        });
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
      return this.#mapRemoval(await this.#capability.binding!.removeOwnedTree!(
        this.#capability.parent!.fd,
        quarantine.name,
        this.#directory!.fd,
      ));
    }
    let removalError: unknown;
    try {
      const guard = await createAsyncDirectoryGuard(this.#capability.parent!.receipt.path);
      await withAsyncDirectoryGuards([guard], async () => {
        this.#assertQuarantine(quarantine);
        try {
          await fs.rm(quarantine.path, { recursive: true, force: true });
        } catch (error) {
          removalError = error;
          throw error;
        }
      });
      return "removed";
    } catch (error) {
      if (error === removalError) throw error;
      return "indeterminate";
    }
  }

  #removeSync(quarantine: Quarantine): TempWorkspaceCleanupResult {
    if (quarantine.nativeRemoval) {
      return this.#mapRemoval(this.#capability.binding!.removeOwnedTreeSync!(
        this.#capability.parent!.fd,
        quarantine.name,
        this.#directory!.fd,
      ));
    }
    let removalError: unknown;
    try {
      const guard = createSyncDirectoryGuard(this.#capability.parent!.receipt.path);
      withSyncDirectoryGuards([guard], () => {
        this.#assertQuarantine(quarantine);
        try {
          fsSync.rmSync(quarantine.path, { recursive: true, force: true });
        } catch (error) {
          removalError = error;
          throw error;
        }
      });
      return "removed";
    } catch (error) {
      if (error === removalError) throw error;
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
