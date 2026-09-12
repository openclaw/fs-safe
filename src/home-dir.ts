import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "./string-coerce.js";

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
  return raw ? path.resolve(raw) : undefined;
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
  return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
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
  if (!hasHomePrefix(input)) {
    return path.resolve(input);
  }
  const expanded = expandHomePrefix(input, {
    home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
    env: opts?.env,
    homedir: opts?.homedir,
  });
  return path.resolve(expanded);
}
