import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const checker = fileURLToPath(new URL("../scripts/check-fs-boundary-primitives.mjs", import.meta.url));

function checkSyntheticSource(tempTarget: string) {
  const directory = mkdtempSync(join(tmpdir(), "fs-safe-boundary-check-"));
  try {
    const sourceDirectory = join(directory, "src");
    mkdirSync(sourceDirectory);
    for (const file of [
      "replace-file.ts",
      "move-path.ts",
      "private-temp-workspace.ts",
      "sibling-temp.ts",
      "archive-staging.ts",
    ]) {
      writeFileSync(join(sourceDirectory, file), "export {};\n");
    }
    writeFileSync(
      join(sourceDirectory, "json-durable-queue.ts"),
      'import { assertSafePathSegment } from "./safe-path-segment.js";\n',
    );
    writeFileSync(join(sourceDirectory, "temp-target.ts"), tempTarget);
    return spawnSync(process.execPath, [checker], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each([
  {
    name: "accepts both shared temp filename helpers",
    source: 'import { normalizeSafePathSegment, isSafePathSegment } from "./safe-path-segment.js";\n',
    exitCode: 0,
    diagnostic: "",
  },
  {
    name: "reports only the missing normalization helper",
    source: 'import { isSafePathSegment } from "./safe-path-segment.js";\n',
    exitCode: 1,
    diagnostic: "src/temp-target.ts: temp filenames must use the shared normalizeSafePathSegment helper\n",
  },
  {
    name: "reports only the missing validation helper",
    source: 'import { normalizeSafePathSegment } from "./safe-path-segment.js";\n',
    exitCode: 1,
    diagnostic: "src/temp-target.ts: temp filenames must use the shared isSafePathSegment helper\n",
  },
])("$name", ({ source, exitCode, diagnostic }) => {
  const result = checkSyntheticSource(source);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(exitCode);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(diagnostic);
});
