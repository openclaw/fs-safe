// One isolated process owns every native query in a batch, including stuck OS calls.
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { configureFsSafeNative } from "./native-config.js";
import { formatCaughtPermissionFailure } from "./permission-exec.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

async function inspectBatch() {
  const mode = process.env.FS_SAFE_OWNER_DACL_BATCH_MODE;
  if (mode !== "auto" && mode !== "require") {
    throw new FsSafeError("helper-unavailable", "isolated Windows native inspection was not enabled");
  }
  configureFsSafeNative({ mode });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Windows security batch exceeded its input budget");
    chunks.push(buffer);
  }
  const paths: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (!Array.isArray(paths) || !paths.every(value => typeof value === "string" && value && !value.includes("\0"))) {
    throw new Error("Windows security batch contains invalid paths");
  }
  for (const pathname of paths) assertNoWindowsPathAlias(pathname);
  const binding = getNativeBinding();
  const inspect = binding?.readOwnerAndDacl;
  if (!binding || typeof inspect !== "function") {
    throw new FsSafeError("helper-unavailable", "isolated Windows native inspection is unavailable");
  }
  const result = [];
  let outputBytes = Buffer.byteLength(JSON.stringify({ ok: true, result: [] }));
  for (const pathname of paths) {
    const row = { path: pathname, security: inspect.call(binding, pathname) };
    outputBytes += Buffer.byteLength(JSON.stringify(row)) + (result.length ? 1 : 0);
    if (outputBytes > MAX_INPUT_BYTES) {
      throw new FsSafeError("too-large", "Windows security batch exceeded its output budget");
    }
    result.push(row);
  }
  return result;
}

try {
  const result = await inspectBatch();
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "EIO";
  process.stdout.write(JSON.stringify({ ok: false, code, message: formatCaughtPermissionFailure(error) }));
}
