import fs from "node:fs/promises";
import path from "node:path";

export type EntryIdentity = {
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  nlink: number;
  size: number;
};

export type CopiedEntryManifest =
  | (EntryIdentity & {
      children: Array<{ name: string; manifest: CopiedEntryManifest }>;
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

export function entryIdentity(stat: {
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  nlink: number;
  size: number;
}): EntryIdentity {
  return {
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
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
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function sameDirectoryNode(a: EntryIdentity, b: EntryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function sourceChangedError(sourcePath: string): Error {
  return Object.assign(new Error(`Source changed during move fallback: ${sourcePath}`), {
    code: "ESTALE",
  });
}

export async function assertSourceStillMatches(
  sourcePath: string,
  identity: EntryIdentity,
): Promise<void> {
  if (!sameIdentity(identity, entryIdentity(await fs.lstat(sourcePath)))) {
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
  if (manifest.nlink <= 1) {
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
    before.mtimeMs === after.mtimeMs &&
    before.nlink > 0 &&
    after.nlink === before.nlink - 1 &&
    after.ctimeMs >= before.ctimeMs
  );
}

function poisonAliasGroup(group: CleanupAliasGroup): CleanupCopiedEntryResult {
  group.stale = true;
  return "stale";
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

  let observed: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    observed = await fs.lstat(remainingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return poisonAliasGroup(group);
    }
    throw error;
  }
  const observedIdentity = entryIdentity(observed);
  if (!sameOwnedUnlinkTransition(group.expected, observedIdentity)) {
    return poisonAliasGroup(group);
  }
  group.expected = observedIdentity;
  return "removed";
}

function mergeCleanupResults(
  a: CleanupCopiedEntryResult,
  b: CleanupCopiedEntryResult,
): CleanupCopiedEntryResult {
  return a === "stale" || b === "stale" ? "stale" : "removed";
}

export async function cleanupCopiedEntry(
  sourcePath: string,
  manifest: CopiedEntryManifest,
  state: CleanupCopiedEntryState,
  assertBeforeMutation: () => void,
): Promise<CleanupCopiedEntryResult> {
  const aliasGroup =
    manifest.kind === "leaf" ? state.aliasGroups.get(identityKey(manifest)) : undefined;
  if (aliasGroup?.stale) {
    return "stale";
  }

  let currentStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    currentStat = await fs.lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return aliasGroup ? poisonAliasGroup(aliasGroup) : "removed";
    }
    throw error;
  }

  if (manifest.kind === "directory") {
    if (!currentStat.isDirectory() || !sameDirectoryNode(manifest, entryIdentity(currentStat))) {
      return "stale";
    }
    // A same-inode directory can gain unrelated children after commit. Still
    // clean manifest children so the fallback does not duplicate copied files.
    let result: CleanupCopiedEntryResult = "removed";
    for (const child of manifest.children) {
      result = mergeCleanupResults(
        result,
        await cleanupCopiedEntry(
          path.join(sourcePath, child.name),
          child.manifest,
          state,
          assertBeforeMutation,
        ),
      );
    }
    assertBeforeMutation();
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

  const expected = aliasGroup?.expected ?? manifest;
  if (!sameIdentity(expected, entryIdentity(currentStat))) {
    return aliasGroup ? poisonAliasGroup(aliasGroup) : "stale";
  }
  assertBeforeMutation();
  await fs.unlink(sourcePath);
  return aliasGroup
    ? await observeOwnedAliasUnlink(sourcePath, aliasGroup)
    : "removed";
}
