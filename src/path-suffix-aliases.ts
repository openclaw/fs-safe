import { randomInt } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertDirectoryIdentitySync, inspectDirectoryIdentitySync } from "./directory-guard.js";
import { isWindowsReservedDeviceName } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { hasNodeErrorCode } from "./path.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import {
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export type ProbePathSuffixAliasesOptions = {
  directory: string;
  left: string;
  right: string;
  /** Maximum relative component count; defaults to 32. */
  maxDepth?: number;
  /** Synchronous caller policy for differing NFC pairs not equivalent under ASCII case folding. */
  shouldProbeCaseVariants?: (leftNfc: string, rightNfc: string) => boolean;
};

const MAX_SUFFIX_LENGTH = 8_192;
const MAX_PATH_LENGTH = 32_768;
const MAX_SUFFIX_DEPTH = 32;
const MAX_MKDIR_ATTEMPTS = 128;
const MAX_CREATED_DIRECTORIES = 64;
const MAX_FORWARD_OBSERVATIONS = 4_096;
const PROBE_NAME_LENGTH = 6;
const PROBE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const PROBE_FIRST_ALPHABET = "bdefghijkmoqrstuvwxyz";

type ProbePair = readonly [string, string];
type ForbiddenName = (candidate: string) => boolean;
type ProbeDirectory = {
  path: string;
  identity: Pick<BigIntStats, "dev" | "ino">;
  parent?: ProbeDirectory;
};

function unavailable(): never {
  throw new Error("path suffix probe resources or cleanup authority are unavailable");
}

function assertMutationPath(value: string): void {
  if (value.length > MAX_PATH_LENGTH) unavailable();
}

function suffixSegments(value: string, maxDepth: number): string[] {
  if (typeof value !== "string") throw new TypeError("suffix must be a string");
  if (value.length > MAX_SUFFIX_LENGTH) throw new RangeError("suffix exceeds 8192 code units");
  if (value.includes("\0") || path.isAbsolute(value)) {
    throw new TypeError("suffix must be a relative path without NUL bytes");
  }
  const windows = process.platform === "win32";
  const segments = (windows ? value.replaceAll("/", "\\") : value).split(path.sep);
  if (segments.length > maxDepth) throw new RangeError(`suffix exceeds ${maxDepth} components`);
  if (segments.some(segment => !segment || segment === "." || segment === ".." ||
      (windows && (segment.includes(":") || /^[ .]+$/u.test(segment) ||
        isWindowsReservedDeviceName(segment))))) {
    throw new TypeError("suffix must contain ordinary relative path components");
  }
  return segments;
}

function areAsciiCaseVariants(left: string, right: string): boolean {
  const fold = (value: string) =>
    value.replace(/[A-Z]/gu, letter => String.fromCharCode(letter.charCodeAt(0) + 0x20));
  return fold(left) === fold(right);
}

function forbiddenNames(leftNfc: string, rightNfc: string): ForbiddenName {
  const lower = new Set([leftNfc.toLowerCase(), rightNfc.toLowerCase()]);
  const upper = new Set([leftNfc.toUpperCase(), rightNfc.toUpperCase()]);
  // These conservative exclusions never classify filesystem aliases.
  return candidate => {
    const normalized = candidate.normalize("NFC");
    return lower.has(normalized.toLowerCase()) || upper.has(normalized.toUpperCase());
  };
}

function* normalizationProbePairs(
  left: string,
  right: string,
  forbidden: ForbiddenName,
  availableNameLength: number,
): Generator<ProbePair, void> {
  const seen = new Set<string>();
  const replaceAscii = (value: string, replacements: ReadonlyMap<string, string>) =>
    value.replace(/[A-Za-z]/gu, character => {
      const lower = character.toLowerCase();
      const replacement = replacements.get(lower);
      return replacement ? character === lower ? replacement : replacement.toUpperCase() : character;
    });
  const presentAscii = [...new Set(`${left}${right}`.toLowerCase().match(/[a-z]/gu) ?? [])];
  const mutableAscii = presentAscii.filter(source => {
    const replacements = new Map([[source, source === "z" ? "y" : "z"]]);
    return areAsciiCaseVariants(
      replaceAscii(left, replacements).normalize("NFC"),
      replaceAscii(right, replacements).normalize("NFC"),
    );
  });
  for (let attempt = 0; attempt < 24 && mutableAscii.length > 0; attempt++) {
    const replacements = new Map(mutableAscii.map(source => [
      source, String.fromCharCode("a".charCodeAt(0) + randomInt(26)),
    ]));
    const first = replaceAscii(left, replacements);
    const second = replaceAscii(right, replacements);
    if (first.length > availableNameLength || second.length > availableNameLength ||
        !areAsciiCaseVariants(first.normalize("NFC"), second.normalize("NFC")) ||
        isWindowsReservedDeviceName(first) || isWindowsReservedDeviceName(second) ||
        forbidden(first) || forbidden(second)) continue;
    const key = `${first}\0${second}`;
    if (!seen.has(key)) {
      seen.add(key);
      yield [first, second];
    }
  }
}

function createPrivateProbeName(nameLength: number): string {
  let name = "";
  for (let index = 0; index < nameLength; index++) {
    const alphabet = index === 0 ? PROBE_FIRST_ALPHABET : PROBE_ALPHABET;
    name += alphabet[randomInt(alphabet.length)];
  }
  return name;
}

function* asciiCaseProbePairs(nameLength: number, forbidden: ForbiddenName): Generator<ProbePair, void> {
  let count = 0;
  for (let attempt = 0; attempt < 96 && count < 24; attempt++) {
    const first = createPrivateProbeName(nameLength);
    const second = `${first[0]!.toUpperCase()}${first.slice(1)}`;
    if (!forbidden(first) && !forbidden(second)) {
      count++;
      yield [first, second];
    }
  }
}

function* privateProbeNames(nameLength: number, forbidden: ForbiddenName): Generator<string, void> {
  let count = 0;
  for (let attempt = 0; attempt < 96 && count < 24; attempt++) {
    const name = createPrivateProbeName(nameLength);
    if (!forbidden(name)) {
      count++;
      yield name;
    }
  }
}

function* prependPair(first: ProbePair, remaining: Iterable<ProbePair>): Generator<ProbePair, void> {
  yield first;
  yield* remaining;
}

class ProbeDirectories {
  readonly root: ProbeDirectory;
  readonly created: ProbeDirectory[] = [];
  cleanupComplete = true;
  private observations = 0;
  private mkdirAttempts = 0;
  private creations = 0;
  private readonly maxObservations: number;
  private readonly maxMkdirAttempts: number;
  private readonly maxCreations: number;

  constructor(private readonly requestedDirectory: string, depth: number) {
    // The suffix-length limit bounds actual depth, so these products remain safe integers.
    const scale = Math.max(1, depth / MAX_SUFFIX_DEPTH);
    this.maxObservations = MAX_FORWARD_OBSERVATIONS * scale * scale;
    this.maxMkdirAttempts = MAX_MKDIR_ATTEMPTS * scale;
    this.maxCreations = MAX_CREATED_DIRECTORIES * scale;
    this.observe(1);
    const canonical = realpathSync.native(pathForWindowsFilesystem(requestedDirectory));
    assertMutationPath(canonical);
    this.observe(2);
    this.root = { path: canonical, identity: inspectDirectoryIdentitySync(canonical) };
    this.assert(this.root);
  }

  private reserveObservations(units: number): void {
    if (units > this.maxObservations - this.observations) unavailable();
  }

  private observe(units: number, cleanup = false): void {
    if (cleanup) return;
    this.reserveObservations(units);
    this.observations += units;
  }

  assert(directory: ProbeDirectory, cleanup = false): void {
    this.observe(1, cleanup);
    if (realpathSync.native(pathForWindowsFilesystem(this.requestedDirectory)) !== this.root.path) {
      throw new FsSafeError("path-mismatch", "probe directory changed");
    }
    for (let current: ProbeDirectory | undefined = directory; current; current = current.parent) {
      // Each strict identity helper can perform two observations on Windows.
      this.observe(2, cleanup);
      assertDirectoryIdentitySync(current.path, current.identity);
    }
  }

  create(parent: ProbeDirectory, name: string): ProbeDirectory | undefined {
    if (this.mkdirAttempts >= this.maxMkdirAttempts || this.creations >= this.maxCreations) unavailable();
    const probePath = path.join(parent.path, name);
    assertMutationPath(probePath);
    this.assert(parent);
    // Exhaustion must not itself create an entry whose first identity cannot be read.
    this.reserveObservations(2);
    this.mkdirAttempts++;
    try {
      fs.mkdirSync(probePath);
    } catch (error) {
      if (hasNodeErrorCode(error, "EEXIST")) return undefined;
      throw error;
    }
    this.creations++;
    this.observe(2);
    // A failed initial observation can still leave an entry: mkdir returns no descriptor.
    const created = { path: probePath, identity: inspectDirectoryIdentitySync(probePath), parent };
    this.created.push(created);
    this.assert(created);
    return created;
  }

  remove(created: ProbeDirectory, cleanup = false): boolean {
    try {
      this.assert(created, cleanup);
      assertMutationPath(created.path);
      // Never recurse: unexpected children and replacements must remain.
      fs.rmdirSync(created.path);
      return true;
    } catch {
      return false;
    }
  }

  probe(parent: ProbeDirectory, pairs: Iterable<ProbePair>):
      { aliases: boolean; directory: ProbeDirectory } | undefined {
    for (const [first, alternate] of pairs) {
      const alternatePath = path.join(parent.path, alternate);
      assertMutationPath(alternatePath);
      const created = this.create(parent, first);
      if (!created) continue;
      let alias: BigIntStats | undefined;
      this.observe(2);
      try {
        alias = inspectFileIdentitySync(() => fs.lstatSync(alternatePath, { bigint: true }));
      } catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT")) throw error;
      }
      this.assert(created);
      if (!alias) return { aliases: false, directory: created };
      if (alias.isDirectory() && !alias.isSymbolicLink() && sameFileIdentityForCleanup(created.identity, alias)) {
        return { aliases: true, directory: created };
      }
      // A different alternate entry is a collision. Lost cleanup authority ends probing.
      if (!this.remove(created)) {
        this.cleanupComplete = false;
        unavailable();
      }
      this.created.splice(this.created.indexOf(created), 1);
    }
    return undefined;
  }

  neutral(parent: ProbeDirectory, nameLength: number, forbidden: ForbiddenName): ProbeDirectory | undefined {
    for (const name of privateProbeNames(nameLength, forbidden)) {
      const created = this.create(parent, name);
      if (created) return created;
    }
    return undefined;
  }

  cleanup(): boolean {
    // Cleanup bypasses the forward budget; creation and depth caps bound its work.
    for (let index = this.created.length - 1; index >= 0; index--) {
      if (!this.remove(this.created[index]!, true)) this.cleanupComplete = false;
    }
    try { this.assert(this.root, true); }
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
      path.join(owner.root.path, leftSegments.join(path.sep)).length,
      path.join(owner.root.path, rightSegments.join(path.sep)).length,
    );
    const availableNameLength = maxProbePathLength - probeParent.path.length -
      (probeParent.path.endsWith(path.sep) ? 0 : 1);
    const nameLength = Math.max(1, Math.min(PROBE_NAME_LENGTH, left.length, right.length));
    const forbidden = forbiddenNames(normalizedLeft, normalizedRight);
    let next: ProbeDirectory | undefined;

    if (normalizedLeft !== normalizedRight) {
      let caseParent = probeParent;
      let pairs: Iterable<ProbePair>;
      if (asciiCaseVariants) {
        pairs = asciiCaseProbePairs(nameLength, forbidden);
      } else {
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
      const generated = normalizationProbePairs(left, right, forbidden, availableNameLength);
      const first = generated.next();
      let pairs: Iterable<ProbePair>;
      let normalizationParent = probeParent;
      // Fallback only when no generated pair exists, not when generated names collide.
      if (first.done) {
        const neutral = owner.neutral(probeParent, nameLength, forbidden);
        if (!neutral) return undefined;
        normalizationParent = neutral;
        pairs = [[left, right]];
      } else {
        pairs = prependPair(first.value, generated);
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

/** Observe bounded missing suffix aliases; the caller owns caching and ambiguity policy. */
export function probePathSuffixAliasesSync(options: ProbePathSuffixAliasesOptions): boolean | undefined {
  const requestedDirectory = options.directory;
  if (typeof requestedDirectory !== "string") throw new TypeError("directory must be a string");
  if (requestedDirectory.length > MAX_PATH_LENGTH) throw new RangeError("directory exceeds 32768 code units");
  if (requestedDirectory.includes("\0")) throw new TypeError("directory must be a path without NUL bytes");
  // Preserve one-argument Windows drive-relative resolution before reentrant option getters.
  const directory = resolvePathPreservingWindowsRoot(requestedDirectory);
  if (directory.length > MAX_PATH_LENGTH) throw new RangeError("resolved directory exceeds 32768 code units");
  const requestedMaxDepth = options.maxDepth;
  const maxDepth = requestedMaxDepth === undefined ? MAX_SUFFIX_DEPTH : requestedMaxDepth;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError("maxDepth must be a non-negative safe integer");
  }
  const leftInput = options.left;
  const rightInput = options.right;
  const predicate = options.shouldProbeCaseVariants;
  const left = suffixSegments(leftInput, maxDepth);
  const right = suffixSegments(rightInput, maxDepth);
  if (left.length !== right.length) throw new TypeError("suffixes must have the same component count");
  if (predicate !== undefined && typeof predicate !== "function") {
    throw new TypeError("shouldProbeCaseVariants must be a function");
  }
  if (leftInput === rightInput) return true;
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
    observed = observeSuffixes(() => owner ??= new ProbeDirectories(directory, left.length), left, right, shouldProbe);
    owner?.assert(owner.root);
  } catch {
    observed = undefined;
    if (callbackFailure) throw callbackFailure.error;
  } finally {
    if (owner) cleaned = owner.cleanup();
  }
  return cleaned ? observed : undefined;
}
