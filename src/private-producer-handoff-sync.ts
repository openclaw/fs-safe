import fs from "node:fs";
import { ownFileDescriptorSync, type OwnedFileDescriptorSync } from "./create-owned-file.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import {
  assertInitialSource,
  FileHandoff,
  inspectLinkedFile,
  type CreatedHandoffParams,
} from "./private-producer-handoff.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";

export function handoffCreatedFileSync(
  params: CreatedHandoffParams<OwnedFileDescriptorSync, void>,
): OwnedFileDescriptorSync {
  let retained = params.source;
  const owners = new Set([retained]);
  const failures: unknown[] = [];
  const state = new FileHandoff(params, params.identity, true);

  function close(owner: OwnedFileDescriptorSync): void {
    // A throwing close may already have released the descriptor for reuse.
    owners.delete(owner);
    try {
      owner.close();
    } catch (error) {
      state.closeFailed = true;
      throw error;
    }
  }

  function verifyCurrent(owner: OwnedFileDescriptorSync, descriptorPath: string, links: bigint): void {
    state.inspect(owner, links);
    params.verifyDescriptor?.(owner.fd, descriptorPath, Number(links));
  }

  try {
    assertInitialSource(params.identity);
    verifyCurrent(retained, params.sourcePath, 1n);
    assertSynchronousCallbackResult(params.assertBeforeMutation?.(), "assertBeforeMutation");
    state.inspect(retained, 1n);
    state.publish();
    try {
      params.onPublished?.();
    } catch (error) {
      failures.push(error);
    }

    if (process.platform === "win32") {
      verifyCurrent(retained, params.sourcePath, 2n);
      // Keep the original pin until a verified published-name pin exists, so
      // Windows can retire the staging name without leaving it delete-pending.
      const sibling = ownFileDescriptorSync(fs.openSync(
        params.targetPath, fs.constants.O_RDWR | resolveReadOpenFlags(),
      ));
      owners.add(sibling);
      verifyCurrent(sibling, params.targetPath, 2n);
      inspectLinkedFile(
        () => fs.fstatSync(retained.fd, { bigint: true }), params.identity, 2n, "created file descriptor",
      );
      close(retained);
      retained = sibling;
    }

    const descriptorPath = process.platform === "win32" ? params.targetPath : params.sourcePath;
    verifyCurrent(retained, descriptorPath, 2n);
    assertSynchronousCallbackResult(params.assertBeforeMutation?.(), "assertBeforeMutation");
    state.inspect(retained, 2n);
    // Link and unlink stay in one JS turn. Only the verified stage is removed;
    // publication has committed and the destination is never rollback cleanup.
    state.retireSource();
    verifyCurrent(retained, params.targetPath, 1n);
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 0) return retained;
  for (const owner of owners) {
    try {
      close(owner);
    } catch (error) {
      failures.push(error);
    }
  }
  throw state.failure(failures, "created file publication and settlement failed");
}
