import { platform } from "node:os";
import { absolutePathWithRawSegments } from "./root-path-existing.js";

const needsAbsolutePath = Boolean(process.versions.bun) && platform() === "win32";

/** Bun's Windows recursive mkdir cannot inspect existing relative dot components. */
export function recursiveMkdirPath(directory: string): string {
  // Preserve junction/parent traversal; path.resolve would erase those components.
  return needsAbsolutePath ? absolutePathWithRawSegments(directory) : directory;
}
