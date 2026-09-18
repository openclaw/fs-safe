import fs, { type BigIntStats } from "node:fs";
import { ownFileDescriptorSync, type OwnedFileDescriptorSync } from "./create-owned-file.js";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import {
  assertInitialSource,
  assertParents,
  inspectLinkedFile,
  normalizeLinkError,
} from "./private-producer-handoff.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";

export function handoffCreatedFileSync(params: {
  source: OwnedFileDescriptorSync;
  sourcePath: string;
  targetPath: string;
  identity: BigIntStats;
  assertSourceParent: () => void;
  assertTargetParent: () => void;
  assertBeforeMutation?: () => void;
  verifyDescriptor?: (fd: number, path: string, links: number) => void;
  onPublished?: () => void;
}): OwnedFileDescriptorSync {
  let retained = params.source;
  const owners = new Set([retained]);
  const failures: unknown[] = [];
  let publication: "not-published" | "published" | "indeterminate" = "not-published";
  let cleanup: "preserved" | "removed" | "failed" = "preserved";
  let closeFailed = false;

  function close(owner: OwnedFileDescriptorSync): void {
    // A throwing close may already have released the descriptor for reuse.
    owners.delete(owner);
    try {
      owner.close();
    } catch (error) {
      closeFailed = true;
      throw error;
    }
  }

  function assertIdentityCurrent(owner: OwnedFileDescriptorSync, links: bigint): void {
    assertParents(params);
    inspectLinkedFile(
      () => fs.fstatSync(owner.fd, { bigint: true }), params.identity, links, "created file descriptor",
    );
    if (cleanup !== "removed") {
      inspectLinkedFile(
        () => fs.lstatSync(params.sourcePath, { bigint: true }), params.identity, links, "created file stage",
      );
    }
    if (publication === "published") {
      inspectLinkedFile(
        () => fs.lstatSync(params.targetPath, { bigint: true }), params.identity, links, "created file destination",
      );
    }
  }

  function verifyCurrent(owner: OwnedFileDescriptorSync, descriptorPath: string, links: bigint): void {
    assertIdentityCurrent(owner, links);
    params.verifyDescriptor?.(owner.fd, descriptorPath, Number(links));
  }

  try {
    assertInitialSource(params.identity);
    verifyCurrent(retained, params.sourcePath, 1n);
    assertSynchronousCallbackResult(params.assertBeforeMutation?.(), "assertBeforeMutation");
    assertIdentityCurrent(retained, 1n);
    publication = "indeterminate";
    try {
      fs.linkSync(params.sourcePath, params.targetPath);
    } catch (error) {
      const normalized = normalizeLinkError(error);
      if (normalized instanceof FsSafeError &&
        (normalized.code === "already-exists" || normalized.code === "helper-unavailable")) {
        publication = "not-published";
      }
      throw normalized;
    }
    publication = "published";
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
    assertIdentityCurrent(retained, 2n);
    cleanup = "failed";
    // Link and unlink stay in one JS turn. Only the verified stage is removed;
    // publication has committed and the destination is never rollback cleanup.
    fs.unlinkSync(params.sourcePath);
    cleanup = "removed";
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
  const primary = failures[0];
  // Collision-as-no-op callers must still observe a failed settlement.
  const code = closeFailed || failures.length > 1
    ? "helper-failed"
    : primary instanceof FsSafeError ? primary.code : "helper-failed";
  throw new FsSafeError(
    code,
    "created file publication failed",
    {
      cause: failures.length === 1 ? primary : new AggregateError(failures, "created file publication and settlement failed"),
      details: {
        publication: { status: publication },
        cleanup,
        resources: closeFailed ? "close-failed" : "closed",
        path: params.targetPath,
        dev: params.identity.dev,
        ino: params.identity.ino,
      },
    },
  );
}
