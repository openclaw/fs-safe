import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { sameFileIdentityForCleanup, sha256Hex } from "./file-identity.js";
import type { NativeWriteParent } from "./pinned-write-types.js";

function stagingPrefix(target: string): string {
  return `.fs-safe-lock-${sha256Hex(`${os.hostname()}\0${path.basename(target)}`).slice(0, 16)}-`;
}

export function sidecarStagingPath(target: string): string {
  return path.join(path.dirname(target), `${stagingPrefix(target)}${process.pid}-${randomUUID()}.tmp`);
}

function ownerAbsent(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  return false;
}

// Bound opportunistic cleanup to 64 entries plus one exact publication link.
// Never remove the final lock, live owners, or unverifiable identities.
export function cleanupSidecarStages(
  target: string, assertCurrent: (candidate?: string) => void, native?: NativeWriteParent,
  onlyStage?: { name: string; identity: fs.BigIntStats },
): void {
  const directory = path.dirname(target), prefix = stagingPrefix(target);
  let entries: fs.Dir | undefined;
  let authorityFailure: { error: unknown } | undefined;
  const assertAuthority = (candidate?: string) => {
    try { assertCurrent(candidate); }
    catch (error) { authorityFailure = { error }; throw error; }
  };
  try {
    assertAuthority();
    if (!onlyStage) entries = fs.opendirSync(directory);
    for (let count = 0; count < (onlyStage ? 1 : 64); count++) {
      const entry = onlyStage ?? entries!.readSync();
      if (!entry) break;
      if (!entry.name.startsWith(prefix)) continue;
      const suffix = entry.name.slice(prefix.length);
      const match = /^([1-9]\d*)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/.exec(suffix);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || !ownerAbsent(pid)) continue;
      const candidate = path.join(directory, entry.name);
      let fd: number | undefined;
      try {
        assertAuthority(candidate);
        const before = fs.lstatSync(candidate, { bigint: true });
        if (onlyStage && !sameFileIdentityForCleanup(before, onlyStage.identity)) continue;
        if (!before.isFile() || before.isSymbolicLink() || before.nlink > 2n ||
          (process.getuid && before.uid !== BigInt(process.getuid()))) continue;
        fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const held = fs.fstatSync(fd, { bigint: true });
        if (!sameFileIdentityForCleanup(before, held)) continue;
        assertAuthority(candidate);
        const current = fs.lstatSync(candidate, { bigint: true });
        if (!sameFileIdentityForCleanup(current, held) || !ownerAbsent(pid)) continue;
        if (native?.binding.removeStagedFile) native.binding.removeStagedFile(native.fd, entry.name, fd);
        else fs.unlinkSync(candidate);
      } catch {
        if (authorityFailure) throw authorityFailure.error;
        // Cleanup is optional; the unique new stage does not depend on it.
      } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* Best effort. */ } }
    }
  } catch {
    if (authorityFailure) throw authorityFailure.error;
    // Denied enumeration must not turn a working exclusive create into a failure.
  } finally { try { entries?.closeSync(); } catch { /* Best effort. */ } }
  if (!onlyStage) sidecarPublicationPending(target, (name, identity) =>
    cleanupSidecarStages(target, assertCurrent, native, { name, identity }));
}
// Readers reject the linked record and retry. Authorized cleanup may handle
// the one matching stage; recognition streams past the opportunistic budget.
export function sidecarPublicationPending(
  target: string, onStage?: (name: string, identity: fs.BigIntStats) => void,
): boolean {
  let entries: fs.Dir | undefined;
  let callbackFailure: { error: unknown } | undefined;
  try {
    const current = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!current) return true;
    if (!current.isFile() || current.isSymbolicLink()) return false;
    if (current.nlink === 1n) return true;
    if (current.nlink !== 2n) return false;
    const prefix = stagingPrefix(target);
    entries = fs.opendirSync(path.dirname(target));
    for (;;) {
      const entry = entries.readSync();
      if (!entry) break;
      if (!entry.name.startsWith(prefix) || !/^[1-9]\d*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/.test(entry.name.slice(prefix.length))) continue;
      const stage = fs.lstatSync(path.join(path.dirname(target), entry.name), { bigint: true, throwIfNoEntry: false });
      if (stage?.isFile() && !stage.isSymbolicLink() && sameFileIdentityForCleanup(stage, current)) {
        try { onStage?.(entry.name, current); }
        catch (error) { callbackFailure = { error }; throw error; }
        return true;
      }
    }
    const after = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
    return !after || !sameFileIdentityForCleanup(after, current) || after.nlink === 1n;
  } catch { if (callbackFailure) throw callbackFailure.error; return false; }
  finally { try { entries?.closeSync(); } catch { /* Observation remains inconclusive. */ } }
}
