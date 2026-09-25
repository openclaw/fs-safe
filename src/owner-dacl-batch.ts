import path from "node:path";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { projectOwnerAndDacl, type OwnerAndDaclResult } from "./owner-dacl.js";
import { anchorWindowsDriveRelativePath, assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { readWindowsSecurityFactsBatch, WINDOWS_SECURITY_BATCH_MAX_BYTES } from "./windows-security-command.js";

const DEFAULT_BATCH_TIMEOUT_MS = 60_000;

function snapshotPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths)) throw new TypeError("paths must be an array of path strings");
  const length = paths.length;
  const selected: string[] = [];
  let bytes = 2;
  for (let index = 0; index < length; index += 1) {
    const value = paths[index];
    if (!Object.hasOwn(paths, index) || typeof value !== "string" || !value || value.includes("\0")) {
      throw new TypeError("paths must contain nonempty path strings without null bytes");
    }
    let captured = value;
    if (process.platform === "win32") {
      captured = anchorWindowsDriveRelativePath(value);
      assertNoWindowsPathAlias(captured, "filesystem", "owner and DACL path uses a Windows filesystem namespace alias");
      const root = path.win32.parse(captured).root;
      // Anchor cwd-dependent paths without normalizing their physical . or .. suffix.
      if (root.length <= 1 || !path.win32.isAbsolute(captured)) {
        const base = path.win32.resolve(root || ".");
        captured = `${base}${base.endsWith("\\") ? "" : "\\"}${captured.slice(root.length)}`;
      }
      assertNoWindowsPathAlias(captured, "filesystem", "owner and DACL path uses a Windows filesystem namespace alias");
    }
    bytes += Buffer.byteLength(JSON.stringify(captured), "utf8") + (index ? 1 : 0);
    if (bytes > WINDOWS_SECURITY_BATCH_MAX_BYTES) {
      throw new FsSafeError("too-large", "owner and DACL batch exceeds its input budget");
    }
    selected.push(captured);
  }
  return selected;
}

/** Inspect an ordered batch outside the caller's event loop, without applying trust policy. */
export async function readOwnerAndDaclBatch(
  paths: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<OwnerAndDaclResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be a positive integer no greater than 2147483647");
  }
  const selected = snapshotPaths(paths);
  if (process.platform !== "win32") {
    return selected.map(() => ({ status: "unsupported-platform", platform: process.platform }));
  }
  if (selected.length === 0) return [];
  const config = getFsSafeNativeConfig();
  const native = getNativeBinding();
  const useNative = typeof native?.readOwnerAndDacl === "function";
  if (!useNative) {
    if (config.mode === "require") {
      throw new FsSafeError("helper-unavailable", "Windows owner and DACL facts require an up-to-date native helper");
    }
    warnNativeFallback("windows-owner-dacl", "Windows owner and DACL inspection uses a slower built-in system command.");
  }
  const facts = await readWindowsSecurityFactsBatch(selected, { timeoutMs, native: useNative, mode: config.mode });
  return facts.map(projectOwnerAndDacl);
}
