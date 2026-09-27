import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { hasErrorCode } from "./file-cleanup.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import type { AtomicMutation } from "./replace-file-mutation.js";

function regular(stat: BigIntStats, pathname: string, rejectHardlinks: boolean): BigIntStats {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new FsSafeError("path-mismatch", `Atomic replace destination changed: ${pathname}`);
  }
  if (rejectHardlinks && stat.nlink !== 1n) {
    throw new FsSafeError("hardlink", `Hardlinked atomic replace destination not allowed: ${pathname}`);
  }
  return stat;
}

/** Borrow the writer's descriptor; never adopt an identity from a later pathname open. */
export async function captureAtomicDestination(
  fsModule: Pick<typeof fs, "lstat">,
  handle: FileHandle,
  pathname: string,
  mutation: AtomicMutation,
  rejectHardlinks: boolean,
) {
  const inspect = () => fsModule === fs
    ? fsSync.fstatSync(handle.fd, { bigint: true }) : handle.stat({ bigint: true });
  const identity = await inspectFileIdentity(inspect);
  regular(identity, pathname, rejectHardlinks);
  let writing = false;
  let restoreDescriptorOnly = false;
  const verifyDescriptor = async () => {
    await inspectFileIdentity(async () => regular(await inspect(), pathname, rejectHardlinks), identity);
  };
  const verify = async () => {
    let metadataFailure = false;
    const observe = async (read: () => BigIntStats | Promise<BigIntStats>) => {
      try { return await read(); }
      catch (error) { metadataFailure = hasErrorCode(error, "EIO"); throw error; }
    };
    try {
      await inspectFileIdentity(async () => regular(await observe(inspect), pathname, rejectHardlinks), identity);
      await inspectFileIdentity(async () => regular(await observe(() => fsModule.lstat(pathname, { bigint: true })), pathname, rejectHardlinks), identity);
    } catch (error) {
      if (writing && metadataFailure) {
        // A metadata observation failed, but the already-owned descriptor can
        // still restore its bytes after fresh exact descriptor verification.
        restoreDescriptorOnly = true;
        throw error;
      }
      mutation.refuse(error);
    }
  };
  const verifyRestore = async () => {
    if (!restoreDescriptorOnly) return await verify();
    try { await verifyDescriptor(); }
    catch (error) { mutation.refuse(error); }
  };
  return {
    verify,
    writing: () => { writing = true; mutation.destination("writing", pathname, identity); },
    beforeWrite: async () => {
      mutation.assert();
      await verify();
    },
    beforeRestore: async () => { mutation.assert(); await verifyRestore(); },
    verifyRestore,
    assertBeforeMutation: () => mutation.assert(),
    published: () => mutation.destination("published", pathname, identity),
  };
}

export function captureAtomicDestinationSync(
  fsModule: Pick<typeof fsSync, "lstatSync" | "fstatSync">,
  fd: number,
  pathname: string,
  mutation: AtomicMutation,
  rejectHardlinks: boolean,
) {
  const identity = inspectFileIdentitySync(() => fsModule.fstatSync(fd, { bigint: true }));
  regular(identity, pathname, rejectHardlinks);
  let writing = false;
  let restoreDescriptorOnly = false;
  const verify = () => {
    let metadataFailure = false;
    const observe = (read: () => BigIntStats) => {
      try { return read(); }
      catch (error) { metadataFailure = hasErrorCode(error, "EIO"); throw error; }
    };
    try {
      inspectFileIdentitySync(() => regular(observe(() => fsModule.fstatSync(fd, { bigint: true })), pathname, rejectHardlinks), identity);
      inspectFileIdentitySync(() => regular(observe(() => fsModule.lstatSync(pathname, { bigint: true })), pathname, rejectHardlinks), identity);
    } catch (error) {
      if (writing && metadataFailure) { restoreDescriptorOnly = true; throw error; }
      mutation.refuse(error);
    }
  };
  const verifyRestore = () => {
    if (!restoreDescriptorOnly) return verify();
    try {
      inspectFileIdentitySync(() => regular(fsModule.fstatSync(fd, { bigint: true }), pathname, rejectHardlinks), identity);
    } catch (error) { mutation.refuse(error); }
  };
  return {
    verify,
    writing: () => { writing = true; mutation.destination("writing", pathname, identity); },
    beforeWrite: () => {
      mutation.assert();
      verify();
    },
    beforeRestore: () => { mutation.assert(); verifyRestore(); },
    verifyRestore,
    published: () => mutation.destination("published", pathname, identity),
  };
}
