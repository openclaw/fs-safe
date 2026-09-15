function isValidUid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function unavailable(cause?: unknown): Error {
  return new Error("Effective user identity is unavailable.", {
    ...(cause === undefined ? {} : { cause }),
  });
}

export function resolveEffectiveUid(): number {
  const provider = process.geteuid;
  if (typeof provider !== "function") {
    throw unavailable();
  }
  let uid: unknown;
  try {
    uid = provider.call(process);
  } catch (cause) {
    throw unavailable(cause);
  }
  if (!isValidUid(uid)) {
    throw unavailable();
  }
  return uid;
}
