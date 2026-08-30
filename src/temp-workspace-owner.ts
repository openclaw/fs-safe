import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createAsyncDirectoryGuard, createSyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup, type FileIdentityStat } from "./file-identity.js";
import { withAsyncDirectoryGuards, withSyncDirectoryGuards } from "./guarded-mutation.js";
import { requireNativeBinding, type NativeBinding } from "./native.js";
import { assertStagedDirectoryCurrent, openStagedDirectory } from "./staged-directory.js";

export type TempWorkspaceCleanupResult = "removed" | "missing" | "identity-mismatch" | "indeterminate";

type Parent = ReturnType<typeof openStagedDirectory>;
type Quarantine = { path: string };

export class TempWorkspaceCleanupCapability {
  readonly binding: NativeBinding;
  readonly parent: Parent;
  #closed = false;

  constructor(root: string) {
    this.binding = requireNativeBinding();
    if (typeof this.binding.renameNoReplace !== "function") {
      throw new FsSafeError("helper-unavailable", "temp workspaces require native no-replace directory rename");
    }
    try {
      this.parent = openStagedDirectory(root);
    } catch (cause) {
      throw new FsSafeError("helper-unavailable", "temp workspaces require a retained parent descriptor", { cause });
    }
    try {
      this.assertCurrent();
    } catch (cause) {
      try {
        this.close();
      } catch (closeError) {
        cause = new AggregateError([cause, closeError], "temp workspace parent admission and close failed");
      }
      throw new FsSafeError("helper-unavailable", "temp workspace parent cannot be safely retained", { cause });
    }
  }

  assertCurrent(): void {
    if (this.#closed) {
      throw new FsSafeError("path-mismatch", "temp workspace cleanup parent is closed");
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
    fsSync.closeSync(this.parent.fd);
  }
}

export class TempWorkspaceCleanupOwner {
  readonly #dir: string;
  readonly #identity: FileIdentityStat;
  readonly #capability: TempWorkspaceCleanupCapability;
  readonly #parent: Parent;
  readonly #parentReceipt: Parent["receipt"];
  #running = false;
  #result?: TempWorkspaceCleanupResult;
  #pending?: Promise<TempWorkspaceCleanupResult>;

  constructor(dir: string, identity: FileIdentityStat, capability: TempWorkspaceCleanupCapability) {
    this.#dir = dir;
    this.#identity = { dev: identity.dev, ino: identity.ino };
    this.#capability = capability;
    this.#parent = capability.parent;
    this.#parentReceipt = capability.parent.receipt;
  }

  #repeat(): TempWorkspaceCleanupResult {
    return this.#result === "removed" ? "missing" : this.#result!;
  }

  #finish(result: TempWorkspaceCleanupResult): TempWorkspaceCleanupResult {
    this.#result ??= result;
    try {
      this.#capability.close();
    } catch (error) {
      this.#result = "indeterminate";
      throw error;
    }
    return this.#result;
  }

  #assertParent(): void {
    this.#capability.assertCurrent();
  }

  #restore(name: string, identity: FileIdentityStat): TempWorkspaceCleanupResult {
    try {
      this.#assertParent();
      const parent = this.#parent;
      this.#capability.binding.renameNoReplace(parent.fd, name, parent.fd, path.basename(this.#dir));
      this.#assertParent();
      const restored = fsSync.lstatSync(this.#dir, { bigint: true });
      this.#assertParent();
      return sameFileIdentityForCleanup(restored, identity) ? "identity-mismatch" : "indeterminate";
    } catch {
      // A newer public entry, failed rename, or ambiguous parent leaves every
      // remaining name alone. Never overwrite the public name to repair a race.
      return "indeterminate";
    }
  }

  #prepare(): Quarantine | TempWorkspaceCleanupResult {
    try {
      this.#assertParent();
      let current;
      try {
        current = fsSync.lstatSync(this.#dir, { bigint: true });
      } catch (error) {
        // Absence at an old pathname says nothing about a moved owner's child.
        this.#assertParent();
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "indeterminate";
      }
      this.#assertParent();
      if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentityForCleanup(current, this.#identity)) {
        return "identity-mismatch";
      }
      this.#assertParent();
      const name = `.fs-safe-workspace-cleanup-${randomUUID()}`;
      const quarantinePath = path.join(this.#parentReceipt.path, name);
      this.#capability.binding.renameNoReplace(this.#parent.fd, path.basename(this.#dir), this.#parent.fd, name);
      this.#assertParent();
      const quarantined = fsSync.lstatSync(quarantinePath, { bigint: true });
      this.#assertParent();
      if (!quarantined.isDirectory() || quarantined.isSymbolicLink() || !sameFileIdentityForCleanup(quarantined, this.#identity)) {
        return this.#restore(name, quarantined);
      }
      return { path: quarantinePath };
    } catch {
      // Even a failed rename may have committed on a remote filesystem.
      return "indeterminate";
    }
  }

  #assertQuarantine(quarantine: Quarantine): void {
    const current = fsSync.lstatSync(quarantine.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentityForCleanup(current, this.#identity)) {
      throw new FsSafeError("path-mismatch", "temp workspace quarantine changed");
    }
    this.#assertParent();
  }

  async #remove(quarantine: Quarantine): Promise<TempWorkspaceCleanupResult> {
    let removalError: unknown;
    try {
      const guard = await createAsyncDirectoryGuard(this.#parentReceipt.path);
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
    let removalError: unknown;
    try {
      const guard = createSyncDirectoryGuard(this.#parentReceipt.path);
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
    try {
      const prepared = this.#prepare();
      return this.#finish(typeof prepared === "string" ? prepared : await this.#remove(prepared));
    } finally {
      this.#finish("indeterminate");
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
    // Forced process exit cannot wait for an async removal. Revoke any further
    // pathname work and close once; an in-flight removal can only target quarantine.
    if (this.#running) return this.#finish("indeterminate");
    this.#running = true;
    try {
      const prepared = this.#prepare();
      return this.#finish(typeof prepared === "string" ? prepared : this.#removeSync(prepared));
    } finally {
      this.#finish("indeterminate");
    }
  }
}
