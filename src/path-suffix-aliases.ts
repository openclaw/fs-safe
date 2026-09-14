import { randomBytes } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync, inspectDirectoryIdentitySync } from "./directory-guard.js";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { hasNodeErrorCode } from "./path.js";
import { realpathSync } from "./realpath.js";
import { isDriveRelativePath } from "./safe-path-segment.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

export type ProbePathSuffixAliasesOptions = {
  directory: string;
  left: string;
  right: string;
  /** Synchronous caller policy for differing NFC pairs not equivalent under ASCII case folding. */
  shouldProbeCaseVariants?: (leftNfc: string, rightNfc: string) => boolean;
};

const PROBE_NAME_LENGTH = 6;
const PROBE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const PROBE_FIRST_ALPHABET = "bdefghijkmoqrstuvwxyz";

type ProbeDirectory = {
  path: string;
  identity: Pick<BigIntStats, "dev" | "ino">;
  parent?: ProbeDirectory;
};

function suffixSegments(value: string): string[] {
  if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value)) {
    throw new TypeError("suffix must be a relative path without NUL bytes");
  }
  const segments = (process.platform === "win32" ? value.replaceAll("/", "\\") : value).split(path.sep);
  if (segments.some(segment => !segment || segment === "." || segment === ".." ||
      (process.platform === "win32" && (isDriveRelativePath(segment) || segment.includes(":") ||
        isWindowsReservedPathComponent(segment))))) {
    throw new TypeError("suffix must contain ordinary relative path components");
  }
  return segments;
}

function areAsciiCaseVariants(left: string | undefined, right: string | undefined): boolean {
  const foldAsciiCase = (value: string) =>
    value.replace(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0x20));
  return left !== undefined && right !== undefined && foldAsciiCase(left) === foldAsciiCase(right);
}

function isWindowsReservedPathComponent(value: string): boolean {
  const stem = value
    .split(".", 1)[0]!
    .replace(/[ .]+$/u, "")
    .toUpperCase();
  return WINDOWS_RESERVED_DEVICE_NAMES.has(stem);
}

function isForbiddenProbeName(candidate: string, forbiddenNames: ReadonlySet<string>): boolean {
  const normalized = candidate.normalize("NFC");
  // Conservative name exclusion only: these folds never classify path aliases.
  return [...forbiddenNames].some(name => {
    const forbidden = name.normalize("NFC");
    return normalized.toLowerCase() === forbidden.toLowerCase() ||
      normalized.toUpperCase() === forbidden.toUpperCase();
  });
}

function createNormalizationProbePairs(
  left: string,
  right: string,
): readonly (readonly [string, string])[] {
  const pairs: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  const forbiddenNames = new Set([left, right]);
  const addPair = (candidateLeft: string, candidateRight: string) => {
    if (!areAsciiCaseVariants(candidateLeft.normalize("NFC"), candidateRight.normalize("NFC"))) {
      return;
    }
    if (
      isWindowsReservedPathComponent(candidateLeft) ||
      isWindowsReservedPathComponent(candidateRight)
    ) {
      return;
    }
    if (
      isForbiddenProbeName(candidateLeft, forbiddenNames) ||
      isForbiddenProbeName(candidateRight, forbiddenNames)
    ) {
      return;
    }
    const key = `${candidateLeft}\0${candidateRight}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push([candidateLeft, candidateRight]);
    }
  };

  const replaceAscii = (value: string, replacements: ReadonlyMap<string, string>) =>
    value.replace(/[A-Za-z]/gu, (character) => {
      const lower = character.toLowerCase();
      const replacement = replacements.get(lower);
      if (!replacement) {
        return character;
      }
      return character === lower ? replacement : replacement.toUpperCase();
    });
  const presentAscii = [...new Set(`${left}${right}`.toLowerCase().match(/[a-z]/gu) ?? [])];
  const mutableAscii = presentAscii.filter((source) => {
    const replacement = source === "z" ? "y" : "z";
    const replacements = new Map([[source, replacement]]);
    return areAsciiCaseVariants(
      replaceAscii(left, replacements).normalize("NFC"),
      replaceAscii(right, replacements).normalize("NFC"),
    );
  });
  for (let attempt = 0; attempt < 24 && mutableAscii.length > 0; attempt += 1) {
    const entropy = randomBytes(mutableAscii.length);
    const replacements = new Map(
      mutableAscii.map((source, index) => [
        source,
        String.fromCharCode("a".charCodeAt(0) + (entropy[index]! % 26)),
      ]),
    );
    addPair(replaceAscii(left, replacements), replaceAscii(right, replacements));
  }
  return pairs;
}

function createAsciiCaseProbePairs(
  nameLength: number,
  forbiddenNames: ReadonlySet<string>,
): readonly (readonly [string, string])[] {
  const pairs: Array<readonly [string, string]> = [];
  for (let attempt = 0; attempt < 96 && pairs.length < 24; attempt += 1) {
    const base = createPrivateProbeName(nameLength);
    const alias = `${base[0]!.toUpperCase()}${base.slice(1)}`;
    if (!isForbiddenProbeName(base, forbiddenNames) && !isForbiddenProbeName(alias, forbiddenNames)) {
      pairs.push([base, alias]);
    }
  }
  return pairs;
}

function createPrivateProbeName(nameLength: number): string {
  const entropy = randomBytes(nameLength);
  return [...entropy]
    .map((value, index) => {
      const alphabet = index === 0 ? PROBE_FIRST_ALPHABET : PROBE_ALPHABET;
      return alphabet[value % alphabet.length];
    })
    .join("");
}

function createPrivateProbeNames(
  nameLength: number,
  forbiddenNames: ReadonlySet<string>,
): readonly string[] {
  const names: string[] = [];
  for (let attempt = 0; attempt < 96 && names.length < 24; attempt += 1) {
    const name = createPrivateProbeName(nameLength);
    if (!isForbiddenProbeName(name, forbiddenNames)) {
      names.push(name);
    }
  }
  return names;
}


class ProbeDirectories {
  readonly root: ProbeDirectory;
  readonly created: ProbeDirectory[] = [];
  cleanupComplete = true;

  constructor(private readonly requestedDirectory: string) {
    const canonical = realpathSync.native(requestedDirectory);
    this.root = { path: canonical, identity: inspectDirectoryIdentitySync(canonical) };
    this.assert(this.root);
  }

  assert(directory: ProbeDirectory): void {
    if (realpathSync.native(this.requestedDirectory) !== this.root.path) {
      throw new FsSafeError("path-mismatch", "probe directory changed");
    }
    for (let current: ProbeDirectory | undefined = directory; current; current = current.parent) {
      assertDirectoryIdentitySync(current.path, current.identity);
    }
  }

  create(parent: ProbeDirectory, name: string): ProbeDirectory | undefined {
    this.assert(parent);
    const probePath = path.join(parent.path, name);
    try {
      fs.mkdirSync(probePath);
    } catch (error) {
      if (hasNodeErrorCode(error, "EEXIST")) return undefined;
      throw error;
    }
    // This first observation is shared by every later check and cleanup. Failed
    // admission can leave a directory: mkdir supplies no creation descriptor.
    const created = { path: probePath, identity: inspectDirectoryIdentitySync(probePath), parent };
    this.created.push(created);
    this.assert(created);
    return created;
  }

  remove(created: ProbeDirectory): boolean {
    try {
      this.assert(created);
      // Never recurse: unexpected children belong to another actor and must remain.
      fs.rmdirSync(created.path);
      return true;
    } catch {
      return false;
    }
  }

  probe(parent: ProbeDirectory, pairs: readonly (readonly [string, string])[]):
      { aliases: boolean; directory: ProbeDirectory } | undefined {
    for (const [first, alternate] of pairs) {
      const created = this.create(parent, first);
      if (!created) continue;
      let alias: BigIntStats | undefined;
      try {
        alias = inspectFileIdentitySync(() => fs.lstatSync(path.join(parent.path, alternate), { bigint: true }));
      } catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT")) throw error;
      }
      this.assert(created);
      if (!alias) return { aliases: false, directory: created };
      if (alias.isDirectory() && !alias.isSymbolicLink() && sameFileIdentityForCleanup(created.identity, alias)) {
        return { aliases: true, directory: created };
      }
      // A different entry at the alternate spelling is a collision, not a case
      // observation. Discard only our empty entry before trying another pair.
      if (this.remove(created)) this.created.splice(this.created.indexOf(created), 1);
      else this.cleanupComplete = false;
    }
    return undefined;
  }

  neutral(parent: ProbeDirectory, nameLength: number, forbiddenNames: ReadonlySet<string>): ProbeDirectory | undefined {
    for (const name of createPrivateProbeNames(nameLength, forbiddenNames)) {
      const created = this.create(parent, name);
      if (created) return created;
    }
    return undefined;
  }

  cleanup(): boolean {
    for (const created of this.created.toReversed()) {
      if (!this.remove(created)) this.cleanupComplete = false;
    }
    try { this.assert(this.root); }
    catch { this.cleanupComplete = false; }
    return this.cleanupComplete;
  }
}

function observeSuffixes(
  getOwner: () => ProbeDirectories,
  leftSegments: string[],
  rightSegments: string[],
  shouldProbeCaseVariants: (left: string, right: string) => boolean,
): boolean | undefined {
  let maxProbePathLength: number | undefined;
  let probeParent: ProbeDirectory | undefined;
  for (let index = 0; index < leftSegments.length; index++) {
    const left = leftSegments[index]!;
    const right = rightSegments[index]!;
    const normalizedLeft = left.normalize("NFC");
    const normalizedRight = right.normalize("NFC");
    const asciiCaseVariants = areAsciiCaseVariants(normalizedLeft, normalizedRight);
    if (normalizedLeft !== normalizedRight && !asciiCaseVariants &&
        !shouldProbeCaseVariants(normalizedLeft, normalizedRight)) return false;
    const needsNormalization = left !== normalizedLeft || right !== normalizedRight;
    if (normalizedLeft === normalizedRight && !needsNormalization && index === leftSegments.length - 1) continue;
    const owner = getOwner();
    probeParent ??= owner.root;
    maxProbePathLength ??= Math.max(
      path.join(owner.root.path, ...leftSegments).length,
      path.join(owner.root.path, ...rightSegments).length,
    );
    const availableNameLength = maxProbePathLength - probeParent.path.length -
      (probeParent.path.endsWith(path.sep) ? 0 : 1);
    const nameLength = Math.max(1, Math.min(PROBE_NAME_LENGTH, left.length, right.length));
    const forbidden = new Set([left, right]);
    let next: ProbeDirectory | undefined;

    if (normalizedLeft !== normalizedRight) {
      let caseParent = probeParent;
      let pairs = createAsciiCaseProbePairs(nameLength, forbidden);
      if (!asciiCaseVariants) {
        const neutral = owner.neutral(probeParent, nameLength, forbidden);
        if (!neutral) return undefined;
        caseParent = neutral;
        pairs = [[left, right]];
      }
      const observed = owner.probe(caseParent, pairs);
      if (!observed) return undefined;
      if (!observed.aliases) return false;
      next = observed.directory;
    }
    if (needsNormalization) {
      let pairs = createNormalizationProbePairs(left, right).filter(([first, second]) =>
        first.length <= availableNameLength && second.length <= availableNameLength);
      let normalizationParent = probeParent;
      if (pairs.length === 0) {
        const neutral = owner.neutral(probeParent, nameLength, forbidden);
        if (!neutral) return undefined;
        normalizationParent = neutral;
        pairs = [[left, right]];
      }
      const observed = owner.probe(normalizationParent, pairs);
      if (!observed) return undefined;
      if (!observed.aliases) return false;
      next ??= observed.directory;
    }
    if (index < leftSegments.length - 1) {
      next ??= owner.neutral(probeParent, nameLength, forbidden);
      if (!next) return undefined;
      probeParent = next;
    }
  }
  return true;
}

/** Observe selected missing suffix aliases; the caller owns caching and ambiguity policy. */
export function probePathSuffixAliasesSync(options: ProbePathSuffixAliasesOptions): boolean | undefined {
  if (typeof options.directory !== "string" || options.directory.includes("\0")) {
    throw new TypeError("directory must be a path without NUL bytes");
  }
  const left = suffixSegments(options.left);
  const right = suffixSegments(options.right);
  if (left.length !== right.length) throw new TypeError("suffixes must have the same component count");
  const predicate = options.shouldProbeCaseVariants;
  if (predicate !== undefined && typeof predicate !== "function") {
    throw new TypeError("shouldProbeCaseVariants must be a function");
  }
  if (options.left === options.right) return true;
  const directory = path.resolve(options.directory);
  let callbackFailure: { error: unknown } | undefined;
  const shouldProbe = (first: string, second: string) => {
    if (!predicate) return true;
    try {
      const result = predicate(first, second);
      if (typeof result !== "boolean") {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("shouldProbeCaseVariants must return a boolean synchronously");
      }
      return result;
    } catch (error) {
      callbackFailure = { error };
      throw error;
    }
  };
  let owner: ProbeDirectories | undefined;
  let observed: boolean | undefined;
  let cleaned = true;
  try {
    observed = observeSuffixes(() => owner ??= new ProbeDirectories(directory), left, right, shouldProbe);
    owner?.assert(owner.root);
  } catch {
    observed = undefined;
    if (callbackFailure) throw callbackFailure.error;
  } finally {
    if (owner) cleaned = owner.cleanup();
  }
  return cleaned ? observed : undefined;
}
