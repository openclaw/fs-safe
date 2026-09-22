import assert from "node:assert/strict";

// Ported from the independently reviewed classifier harness's complete-environment admission.
export function benchmarkEnvironment(metadata) {
  assert(metadata && typeof metadata === "object" && !Array.isArray(metadata),
    "benchmark environment metadata missing");
  const fields = ["node", "platform", "arch", "cpu", "osRelease"];
  for (const field of fields) {
    assert(typeof metadata[field] === "string" && metadata[field].trim().length > 0,
      `benchmark environment ${field} missing or invalid`);
  }
  const filesystem = metadata.workspaceFilesystem;
  assert(filesystem && typeof filesystem === "object" && !Array.isArray(filesystem),
    "benchmark workspace filesystem missing or invalid");
  assert(Number.isSafeInteger(filesystem.type), "benchmark workspace filesystem type invalid");
  assert(Number.isSafeInteger(filesystem.blockSize) && filesystem.blockSize > 0,
    "benchmark workspace filesystem block size invalid");
  return { ...Object.fromEntries(fields.map(field => [field, metadata[field]])), workspaceFilesystem: filesystem };
}
