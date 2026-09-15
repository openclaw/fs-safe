import os from "node:os";
import path from "node:path";
import process from "node:process";
import { normalizeOptionalString } from "./string-coerce.js";
import {
  assertNoWindowsPathAlias,
  assertNoWindowsPathAliasForPlatform,
  repairResolvedWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

const PATH_ALIAS_MESSAGE = "path uses a Windows filesystem namespace alias";

function isOrdinaryRootedWindowsDrivePath(input: string): boolean {
  const drive = input.charCodeAt(0);
  return input.length >= 3 &&
    ((drive >= 0x41 && drive <= 0x5a) || (drive >= 0x61 && drive <= 0x7a)) &&
    input.charCodeAt(1) === 0x3a &&
    (input.charCodeAt(2) === 0x5c || input.charCodeAt(2) === 0x2f) &&
    input.indexOf(":", 2) === -1;
}

function hasHomePrefix(input: string): boolean {
  return input === "~" || input.startsWith("~/") ||
    (path.sep === "\\" && input.startsWith("~\\"));
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  if (!raw) return undefined;
  assertNoWindowsPathAlias(raw, "filesystem", "home path uses a Windows filesystem namespace alias");
  const resolved = resolvePathPreservingWindowsRoot(raw);
  assertNoWindowsPathAlias(resolved, "filesystem", "home path uses a Windows filesystem namespace alias");
  return resolved;
}

function resolveRawHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (!explicitHome) {
    return resolveRawOsHomeDir(env, homedir);
  }
  if (!hasHomePrefix(explicitHome)) {
    return explicitHome;
  }
  // OPENCLAW_HOME starts with "~"; expand against the os home dir. Fall
  // back to undefined when there is no os home to expand against rather
  // than returning a raw "~"-prefixed path the caller cannot use.
  const fallbackHome = resolveRawOsHomeDir(env, homedir);
  if (!fallbackHome) {
    return undefined;
  }
  return expandHomePrefix(explicitHome, { home: fallbackHome });
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const envHome = normalize(env.HOME);
  if (envHome) {
    return envHome;
  }
  const userProfile = normalize(env.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }
  return normalizeSafe(homedir);
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalize(homedir());
  } catch {
    return undefined;
  }
}

export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const resolved = resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
  assertNoWindowsPathAlias(resolved, "filesystem", "home path uses a Windows filesystem namespace alias");
  return resolved;
}

export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!hasHomePrefix(input)) {
    return input;
  }
  const home =
    normalize(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  if (!home) {
    return input;
  }
  // Expand before normalizing so a following .. traverses the actual home.
  return path.join(home, input.slice(2));
}

function resolveExpandedHomePath(
  input: string,
  opts: { env?: NodeJS.ProcessEnv; homedir?: () => string } | undefined,
): string {
  const expanded = expandHomePrefix(input, {
    home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
    env: opts?.env,
    homedir: opts?.homedir,
  });
  const resolved = resolvePathPreservingWindowsRoot(expanded);
  assertNoWindowsPathAlias(resolved, "filesystem", PATH_ALIAS_MESSAGE);
  return resolved;
}

export function resolveHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input) {
    return input;
  }
  const rawPlatform = process.platform;
  // Primitive ordinary drive paths have exactly one structural colon. Record
  // that admission so an unchanged resolved string does not need rescanning.
  const ordinaryRawAdmitted = rawPlatform === "win32" &&
    typeof input === "string" &&
    isOrdinaryRootedWindowsDrivePath(input);
  if (ordinaryRawAdmitted) {
    // Keep the overwhelmingly common rooted-drive path close to path.resolve
    // itself. Seven-byte inputs retain the general helper's observable
    // namespace-root preflight; a rare six-byte result retains its repair.
    const usedGeneralResolver = input.length === 7;
    const resolved = usedGeneralResolver
      ? resolvePathPreservingWindowsRoot(input)
      : path.resolve(input);
    const repaired = !usedGeneralResolver && resolved.length === 6
      ? repairResolvedWindowsRoot(input, resolved)
      : resolved;
    const resolvedPlatform = process.platform;
    if (repaired !== input || resolvedPlatform === undefined) {
      assertNoWindowsPathAliasForPlatform(
        repaired,
        "filesystem",
        PATH_ALIAS_MESSAGE,
        resolvedPlatform,
      );
    }
    return repaired;
  }
  assertNoWindowsPathAliasForPlatform(input, "filesystem", PATH_ALIAS_MESSAGE, rawPlatform);
  if (!hasHomePrefix(input)) {
    const resolved = resolvePathPreservingWindowsRoot(input);
    const resolvedPlatform = process.platform;
    // This cold branch was not admitted as an ordinary rooted drive. Recheck
    // even an unchanged result because the live platform can change between
    // raw admission and resolved-path admission. Passing undefined preserves
    // the classifier's default process.platform read.
    assertNoWindowsPathAliasForPlatform(
      resolved,
      "filesystem",
      PATH_ALIAS_MESSAGE,
      resolvedPlatform,
    );
    return resolved;
  }
  return resolveExpandedHomePath(input, opts);
}
