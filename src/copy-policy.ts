import { FsSafeError } from "./errors.js";

export type CopyCloneMode = "auto" | "always" | "never";

export function resolveCopyCloneMode(
  mode: CopyCloneMode | undefined,
  defaultMode: CopyCloneMode,
): CopyCloneMode {
  const policy = mode === undefined ? defaultMode : mode;
  if (policy !== "auto" && policy !== "always" && policy !== "never") {
    throw new FsSafeError("invalid-path", "copy clone policy must be auto, always, or never");
  }
  return policy;
}
