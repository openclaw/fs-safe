import { randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync, inspectDirectoryIdentitySync } from "./directory-guard.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { realpathSync } from "./realpath.js";
import { writeTempFileSync } from "./replace-file-descriptor.js";
import { SyncAtomicTempOwner } from "./replace-file-temp-owner.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

export type ProbePathCaseOptions = {
  /** Allow an exclusively created empty probe when existing entries provide no answer. Defaults to true. */
  allowTemporaryProbe?: boolean;
};

function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, character => {
    const lower = character.toLowerCase();
    return character === lower ? character.toUpperCase() : lower;
  });
}

function probeEntry(directory: string, name: string, names: ReadonlySet<string>): boolean | undefined {
  const alternate = swapAsciiCase(name);
  if (alternate === name) return undefined;
  const bothListed = names.has(name) && names.has(alternate);
  const originalPath = path.join(directory, name);
  let original: BigIntStats;
  let observed: boolean;
  try {
    original = inspectFileIdentitySync(() => fs.lstatSync(originalPath, { bigint: true }));
    try {
      const other = inspectFileIdentitySync(() => fs.lstatSync(path.join(directory, alternate), { bigint: true }));
      const sameIdentity = sameFileIdentityForCleanup(original, other);
      if (sameIdentity || bothListed) {
        // Matching inodes can belong to newly linked case-distinct names.
        const currentNames = new Set(fs.readdirSync(directory));
        const bothCurrent = currentNames.has(name) && currentNames.has(alternate);
        if (bothListed && !bothCurrent) return undefined;
        observed = sameIdentity && !bothCurrent;
      } else {
        observed = false;
      }
    } catch (error) {
      if (bothListed || !isNotFoundPathError(error)) return undefined;
      observed = false;
    }
  } catch {
    return undefined;
  }
  // Disappearance during lookup is not evidence that case variants are distinct.
  inspectFileIdentitySync(() => fs.lstatSync(originalPath, { bigint: true }), original);
  return observed;
}

function probeTemporaryEntry(directory: string): boolean | undefined {
  const name = `.fs-safe-case-probe-${randomUUID()}`;
  const owner = new SyncAtomicTempOwner(path.join(directory, name));
  try {
    owner.start();
    owner.adopt(writeTempFileSync({
      fsModule: fs,
      tempPath: owner.pathname,
      content: "",
      mode: 0o600,
      sync: false,
      onIdentity: owner.onIdentity,
    }));
    owner.assertCurrent(fs);
    const observed = probeEntry(directory, name, new Set(fs.readdirSync(directory)));
    owner.assertCurrent(fs);
    return observed;
  } finally {
    // Failed cleanup invalidates the observation; the existing owner retains its exit retry.
    owner.finish({ fsModule: fs, throwOnCleanupError: true });
  }
}

function probeDirectory(
  directory: string,
  allowTemporaryProbe: boolean,
  preferredName?: string,
): boolean | undefined {
  const canonical = realpathSync.native(directory);
  const identity = inspectDirectoryIdentitySync(canonical);
  const names = new Set(fs.readdirSync(canonical));
  let observed = preferredName === undefined ? undefined : probeEntry(canonical, preferredName, names);
  for (const name of names) {
    if (observed !== undefined) break;
    observed = probeEntry(canonical, name, names);
  }
  if (observed === undefined && allowTemporaryProbe) observed = probeTemporaryEntry(canonical);
  assertDirectoryIdentitySync(canonical, identity);
  return realpathSync.native(directory) === canonical ? observed : undefined;
}

/** Observe local ASCII case behavior; unknown observations never imply an operating-system default. */
export function probePathCaseInsensitiveSync(
  targetPath: string,
  options: ProbePathCaseOptions = {},
): boolean | undefined {
  const resolved = path.resolve(targetPath);
  const allowTemporaryProbe = options.allowTemporaryProbe !== false;
  let targetExists = true;
  try {
    fs.lstatSync(resolved);
  } catch (error) {
    if (!isNotFoundPathError(error)) return undefined;
    targetExists = false;
  }
  if (targetExists) {
    try {
      return probeDirectory(path.dirname(resolved), allowTemporaryProbe, path.basename(resolved));
    } catch {
      return undefined;
    }
  }

  let directory = path.dirname(resolved);
  for (;;) {
    let exists = false;
    try {
      exists = fs.statSync(directory).isDirectory();
    } catch {
      // A missing or unreadable component can still have a readable existing ancestor.
    }
    if (exists) {
      try {
        return probeDirectory(directory, allowTemporaryProbe);
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
