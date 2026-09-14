export type EffectiveUidResolutionOptions = {
  /**
   * Historical adapter name retained by secure-temp-root. When supplied, the
   * value is treated as the effective UID rather than the real UID.
   */
  getuid?: () => number | undefined;
  platform?: NodeJS.Platform;
};

function isValidUid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function unavailable(cause?: unknown): Error {
  return new Error("Effective user identity is unavailable.", {
    ...(cause === undefined ? {} : { cause }),
  });
}

export function resolveEffectiveUid(
  options: EffectiveUidResolutionOptions = {},
): number | undefined {
  const platform = options.platform ?? process.platform;
  const provider = options.getuid ?? (
    platform === "win32" || typeof process.geteuid !== "function"
      ? undefined
      : () => process.geteuid!()
  );
  if (provider === undefined) {
    if (platform === "win32") {
      return undefined;
    }
    throw unavailable();
  }
  let uid: number | undefined;
  try {
    uid = provider();
  } catch (cause) {
    throw unavailable(cause);
  }
  if (uid === undefined && platform === "win32") {
    return undefined;
  }
  if (!isValidUid(uid)) {
    throw unavailable();
  }
  return uid;
}
