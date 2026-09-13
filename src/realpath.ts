import fs from "node:fs";
import { platform } from "node:os";
import { getSystemErrorName } from "node:util";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";

const runtimePlatform = process.versions.bun ? platform() : undefined;
const bunPosix = runtimePlatform === "darwin" || runtimePlatform === "linux" ? runtimePlatform : undefined;

function resolve(input: string, native: boolean): string {
  if (bunPosix) {
    // Bun 1.4.2 normalizes native path components and opens the leaf for reads.
    // The Rust OS resolver preserves permissions, locks and physical spelling.
    // Remove this routing once the Bun baseline includes oven-sh/bun#42374.
    if (input.includes("\0")) {
      throw Object.assign(new TypeError("realpath input must not contain null bytes"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    const binding = getNativeBinding();
    if (binding?.canonicalizePath) {
      // Ordinary resolution normalizes both the input and each expanded symlink.
      const result = binding.canonicalizePath(input, !native);
      if (result.path !== undefined) return result.path;
      const errno = -(result.errno!);
      const code = getSystemErrorName(errno);
      throw Object.assign(new Error(`${code}: realpath '${input}'`), {
        code, errno, syscall: "realpath", path: input,
      });
    }
    if (getFsSafeNativeConfig().mode === "require") {
      throw new FsSafeError("helper-unavailable", "native fs-safe canonicalization is unavailable");
    }
    // Honor off/missing-addon policy. These modes retain Bun's runtime limits.
  }
  return native ? fs.realpathSync.native(input) : fs.realpathSync(input);
}

export const realpathSync = Object.assign((input: string) => resolve(input, false), {
  native: (input: string) => resolve(input, true),
});
