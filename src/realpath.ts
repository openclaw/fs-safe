import fs from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { bunRealpathSync } from "./bun-realpath.js";

const runtimePlatform = process.versions.bun ? platform() : undefined;
const bunPosix = runtimePlatform === "darwin" || runtimePlatform === "linux" ? runtimePlatform : undefined;

function resolve(input: string, native: boolean): string {
  if (bunPosix) {
    // Bun 1.4.2 normalizes native path components and opens the leaf for reads.
    // The OS resolver preserves permissions, special files, and physical spelling.
    // Only Node's ordinary variant normalizes dot segments before following links.
    // Remove this adapter once the Bun baseline includes oven-sh/bun#42374.
    return bunRealpathSync(native ? input : path.resolve(input), bunPosix);
  }
  return native ? fs.realpathSync.native(input) : fs.realpathSync(input);
}

export const realpathSync = Object.assign((input: string) => resolve(input, false), {
  native: (input: string) => resolve(input, true),
});
