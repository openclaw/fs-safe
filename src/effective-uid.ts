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
  if (!(typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0)) {
    throw unavailable();
  }
  return uid;
}
