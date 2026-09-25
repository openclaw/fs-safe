import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

export type EntryIdentity = Readonly<Pick<fsSync.BigIntStats,
  "ctimeNs" | "dev" | "ino" | "mode" | "mtimeNs" | "nlink" | "size"
>>;

export type CopiedEntryManifest =
  | (EntryIdentity & {
      children: Array<{ name: string; manifest: CopiedEntryManifest }>;
      directoryIdentity: Readonly<Pick<fsSync.BigIntStats, "dev" | "ino">>;
      kind: "directory";
    })
  | (EntryIdentity & { kind: "leaf" });

type CleanupCopiedEntryResult = "removed" | "stale";

type CleanupAliasGroup = {
  expected: EntryIdentity;
  remainingPaths: Set<string>;
  stale: boolean;
};

export type CleanupCopiedEntryState = {
  aliasGroups: Map<string, CleanupAliasGroup>;
};

export function entryIdentity(stat: EntryIdentity): EntryIdentity {
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    nlink: stat.nlink,
    size: stat.size,
  };
}

export function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export function sourceChangedError(sourcePath: string): Error {
  return Object.assign(new Error(`Source changed during move fallback: ${sourcePath}`), {
    code: "ESTALE",
  });
}

export function inspectSourceEntry(sourcePath: string, observe: () => fsSync.BigIntStats): fsSync.BigIntStats {
  return inspectFileIdentitySync(observe, undefined, process.platform, () => sourceChangedError(sourcePath));
}

export function inspectSourceDirectory(
  sourcePath: string,
  expected?: Pick<fsSync.BigIntStats, "dev" | "ino">,
): fsSync.BigIntStats {
  try {
    return inspectDirectoryIdentitySync(sourcePath, expected);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" ||
      (error instanceof FsSafeError && (error.code === "path-mismatch" || error.code === "not-file"))) {
      throw sourceChangedError(sourcePath);
    }
    throw error;
  }
}

export async function assertSourceStillMatches(
  sourcePath: string,
  identity: EntryIdentity,
): Promise<void> {
  if (!sameIdentity(identity, inspectSourceEntry(sourcePath, () => fsSync.lstatSync(sourcePath, { bigint: true })))) {
    throw sourceChangedError(sourcePath);
  }
}

function identityKey(identity: EntryIdentity): string {
  return `${identity.dev}:${identity.ino}`;
}

function collectAliasCandidates(
  sourcePath: string,
  manifest: CopiedEntryManifest,
  candidates: Map<string, Array<{ manifest: EntryIdentity; path: string }>>,
): void {
  if (manifest.kind === "directory") {
    for (const child of manifest.children) {
      collectAliasCandidates(path.join(sourcePath, child.name), child.manifest, candidates);
    }
    return;
  }
  if (manifest.nlink <= 1n) {
    return;
  }
  const key = identityKey(manifest);
  const entries = candidates.get(key) ?? [];
  entries.push({ manifest, path: sourcePath });
  candidates.set(key, entries);
}

export function createCleanupCopiedEntryState(
  sourcePath: string,
  manifest: CopiedEntryManifest,
): CleanupCopiedEntryState {
  const candidates = new Map<
    string,
    Array<{ manifest: EntryIdentity; path: string }>
  >();
  collectAliasCandidates(sourcePath, manifest, candidates);

  const aliasGroups = new Map<string, CleanupAliasGroup>();
  for (const [key, entries] of candidates) {
    if (entries.length < 2) {
      continue;
    }
    const first = entries[0];
    if (!first || entries.some((entry) => !sameIdentity(first.manifest, entry.manifest))) {
      throw sourceChangedError(sourcePath);
    }
    aliasGroups.set(key, {
      expected: first.manifest,
      remainingPaths: new Set(entries.map((entry) => entry.path)),
      stale: false,
    });
  }
  return { aliasGroups };
}

function sameOwnedUnlinkTransition(before: EntryIdentity, after: EntryIdentity): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.nlink > 0n &&
    after.nlink === before.nlink - 1n &&
    after.ctimeNs >= before.ctimeNs
  );
}

function poisonAliasGroup(group: CleanupAliasGroup): CleanupCopiedEntryResult {
  group.stale = true;
  return "stale";
}

function inspectCleanupLeaf(sourcePath: string, expected: EntryIdentity): fsSync.BigIntStats | undefined {
  let mismatch: Error | undefined;
  try {
    return inspectFileIdentitySync(() => fsSync.lstatSync(sourcePath, { bigint: true }), expected,
      process.platform, () => mismatch = sourceChangedError(sourcePath));
  } catch (error) {
    if (mismatch !== undefined && error === mismatch) return undefined;
    throw error;
  }
}

async function observeOwnedAliasUnlink(
  sourcePath: string,
  group: CleanupAliasGroup,
): Promise<CleanupCopiedEntryResult> {
  group.remainingPaths.delete(sourcePath);
  const remainingPath = group.remainingPaths.values().next().value as string | undefined;
  if (!remainingPath) {
    return "removed";
  }

  let observed: fsSync.BigIntStats | undefined;
  try {
    observed = inspectCleanupLeaf(remainingPath, group.expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return poisonAliasGroup(group);
    }
    throw error;
  }
  if (!observed || !sameOwnedUnlinkTransition(group.expected, observed)) {
    return poisonAliasGroup(group);
  }
  group.expected = entryIdentity(observed);
  return "removed";
}

export async function cleanupCopiedEntry(
  sourcePath: string,
  manifest: CopiedEntryManifest,
  state: CleanupCopiedEntryState,
  assertBeforeMutation: (() => void) | undefined,
): Promise<CleanupCopiedEntryResult> {
  if (manifest.kind === "directory") {
    let currentStat: fsSync.BigIntStats;
    try {
      currentStat = inspectFileIdentitySync(
        () => fsSync.lstatSync(sourcePath, { bigint: true }),
        manifest.directoryIdentity,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return "removed";
      if (error instanceof FsSafeError && error.code === "path-mismatch") return "stale";
      throw error;
    }
    if (!currentStat.isDirectory()) {
      return "stale";
    }
    // A same-inode directory can gain unrelated children after commit. Still
    // clean manifest children so the fallback does not duplicate copied files.
    let result: CleanupCopiedEntryResult = "removed";
    const assertBeforeChildMutation = assertBeforeMutation ? () => {
      assertBeforeMutation();
      inspectSourceDirectory(sourcePath, manifest.directoryIdentity);
    } : undefined;
    for (const child of manifest.children) {
      const childResult = await cleanupCopiedEntry(
        path.join(sourcePath, child.name),
        child.manifest,
        state,
        assertBeforeChildMutation,
      );
      if (childResult === "stale") {
        result = "stale";
      }
    }
    // Child cleanup and the caller's authority check can replace the directory.
    // Keep the final exact observation after both, immediately before removal.
    assertBeforeMutation?.();
    try {
      currentStat = inspectFileIdentitySync(
        () => fsSync.lstatSync(sourcePath, { bigint: true }),
        manifest.directoryIdentity,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return "stale";
      }
      if (error instanceof FsSafeError && error.code === "path-mismatch") return "stale";
      throw error;
    }
    if (!currentStat.isDirectory()) {
      return "stale";
    }
    try {
      await fs.rmdir(sourcePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        return "stale";
      }
      throw error;
    }
    return result;
  }

  const aliasGroup = state.aliasGroups.get(identityKey(manifest));
  if (aliasGroup?.stale) {
    return "stale";
  }
  const expected = aliasGroup?.expected ?? manifest;
  let currentStat: fsSync.BigIntStats | undefined;
  try {
    currentStat = inspectCleanupLeaf(sourcePath, expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return aliasGroup ? poisonAliasGroup(aliasGroup) : "removed";
    }
    throw error;
  }
  for (let observation = 0; ; observation++) {
    if (!currentStat || !sameIdentity(expected, currentStat)) {
      return aliasGroup ? poisonAliasGroup(aliasGroup) : "stale";
    }
    if (observation || !assertBeforeMutation) break;
    assertBeforeMutation();
    currentStat = inspectCleanupLeaf(sourcePath, expected);
  }
  await fs.unlink(sourcePath);
  return aliasGroup
    ? await observeOwnedAliasUnlink(sourcePath, aliasGroup)
    : "removed";
}
