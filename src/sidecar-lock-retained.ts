import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { getNativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { nativeOpenFlags } from "./native-operations.js";
import { sameFileIdentityForCleanup, sha256Hex } from "./file-identity.js";
import { openStagedDirectory } from "./staged-directory.js";

export interface RetainedSidecar {
  readonly identity: Readonly<{ dev: bigint; ino: bigint }>;
  /** Synchronous settlement also works in the process exit handler. Always closes. */
  settle(remove: boolean, reportMismatch?: boolean): void;
}

function mismatch(check: "identity" | "owner record"): FsSafeError {
  return new FsSafeError("path-mismatch", `created sidecar lock ${check} changed; replacement preserved`);
}

/** Called only by the exclusive creator while its verified descriptor is alive. */
export function retainCreatedSidecar(
  lockPath: string, raw: string, createdFd: number, guard: AnyAsyncDirectoryGuard,
): RetainedSidecar | undefined {
  const binding = getNativeBinding();
  if (!binding) return undefined;
  const created = fs.fstatSync(createdFd, { bigint: true });
  if (!created.isFile() || created.nlink !== 1n) throw mismatch("identity");
  const identity = Object.freeze({ dev: created.dev, ino: created.ino });
  const name = path.basename(lockPath);
  if (process.platform === "win32") {
    if (!binding.retainWindowsSidecar) return undefined;
    const native = binding.retainWindowsSidecar(guard.realPath, name,
      BigInt(guard.stat.dev), BigInt(guard.stat.ino), created.dev, created.ino,
      BigInt(Buffer.byteLength(raw)), sha256Hex(raw), 1024 * 1024);
    const admitted = native.admission;
    if (admitted.status !== "retained") {
      throw new FsSafeError("helper-failed", "could not retain created sidecar lock", { details: { result: admitted } });
    }
    return { identity, settle(remove, reportMismatch = true) {
      const result = native.settle(remove);
      if (result.status === "preserved-mismatch") {
        if (reportMismatch || result.resources !== "closed") {
          throw mismatch(result.errors.some(error => /digest|size changed/u.test(error.message)) ? "owner record" : "identity");
        }
        return;
      }
      if (result.errors.length || result.resources !== "closed" ||
        (remove && result.disposition !== "accepted" && result.namespace !== "absent")) {
        throw new FsSafeError("helper-failed", "retained sidecar lock settlement failed", { details: { result } });
      }
    } };
  }
  if (!binding.stagedFileMatches || !binding.removeStagedFile) return undefined;
  const closeFile = captureNativeFdClose(binding);
  const parent = openStagedDirectory({ path: guard.dir, realPath: guard.realPath, identity: guard.stat });
  let fd: number | undefined;
  try {
    fd = binding.openBeneath(parent.fd, name, nativeOpenFlags(fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)).fd;
    const ownedFd = fd;
    const assertIdentity = () => {
      try {
        if (!binding.stagedFileMatches!(parent.fd, name, ownedFd)) throw mismatch("identity");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      const current = fs.fstatSync(ownedFd, { bigint: true });
      if (!current.isFile() || current.nlink !== 1n || !sameFileIdentityForCleanup(created, current)) throw mismatch("identity");
      return true;
    };
    const expected = Buffer.from(raw);
    const assertOwner = () => {
      if (fs.fstatSync(ownedFd, { bigint: true }).size !== BigInt(expected.length)) throw mismatch("owner record");
      const bytes = Buffer.alloc(expected.length);
      let offset = 0;
      while (offset < bytes.length) {
        const read = fs.readSync(ownedFd, bytes, offset, bytes.length - offset, offset);
        if (read === 0) throw mismatch("owner record");
        offset += read;
      }
      if (!bytes.equals(expected)) throw mismatch("owner record");
    };
    if (!assertIdentity()) throw mismatch("identity");
    assertOwner();
    let settled = false;
    return { identity, settle(remove, reportMismatch = true) {
      if (settled) return;
      settled = true;
      const errors: unknown[] = [];
      try {
        if (remove && assertIdentity()) {
          assertOwner();
          if (assertIdentity() && binding.removeStagedFile!(parent.fd, name, ownedFd) === "preserved") throw mismatch("identity");
        }
      } catch (error) {
        if (reportMismatch || !(error instanceof FsSafeError && error.code === "path-mismatch")) errors.push(error);
      }
      try { closeFile(ownedFd); } catch (error) { errors.push(error); }
      try { fs.closeSync(parent.fd); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "sidecar lock cleanup and close failed");
    } };
  } catch (error) {
    const errors = [error];
    try { if (fd !== undefined) closeFile(fd); } catch (closeError) { errors.push(closeError); }
    try { fs.closeSync(parent.fd); } catch (closeError) { errors.push(closeError); }
    if (errors.length > 1) throw new AggregateError(errors, "sidecar retention and close failed");
    throw error;
  }
}
