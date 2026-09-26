#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const checks = [
  {
    file: "src/replace-file.ts",
    forbidden: [
      {
        pattern: /\.copyFile(?:Sync)?\([^,\n]+,\s*(?:params\.)?dest\b/,
        message: "replace-file fallback must not copy directly to the destination path",
      },
    ],
  },
  {
    file: "src/move-path.ts",
    forbidden: [
      {
        pattern: /fs\.cp\(\s*options\.from,\s*options\.to\b/,
        message: "cross-device move fallback must stage before replacing the destination",
      },
      {
        pattern: /fs\.rm\(\s*options\.from\b/,
        message: "move fallback source removal must go through guardedRm",
      },
    ],
  },
  {
    file: "src/private-temp-workspace.ts",
    forbidden: [
      {
        pattern: /readFileSync\(\s*filePath\b/,
        message: "tempWorkspaceSync.read must use a pinned root-file fd",
      },
    ],
  },
  {
    file: "src/sibling-temp.ts",
    forbidden: [
      {
        pattern: /type DirectoryGuard\b/,
        message: "sibling-temp must use the shared directory guard",
      },
    ],
  },
  {
    file: "src/archive-staging.ts",
    forbidden: [
      {
        pattern: /type DirectoryIdentityGuard\b/,
        message: "archive staging must use the shared directory guard",
      },
    ],
  },
];

const requiredImports = [
  {
    file: "src/json-durable-queue.ts",
    pattern: /assertSafePathSegment/,
    message: "durable queue ids must use the shared safe path segment helper",
  },
  {
    file: "src/temp-target.ts",
    pattern: /\bnormalizeSafePathSegment\b/,
    message: "temp filenames must use the shared normalizeSafePathSegment helper",
  },
  {
    file: "src/temp-target.ts",
    pattern: /\bisSafePathSegment\b/,
    message: "temp filenames must use the shared isSafePathSegment helper",
  },
];

const failures = [];

for (const check of checks) {
  const source = read(check.file);
  for (const rule of check.forbidden) {
    if (rule.pattern.test(source)) {
      failures.push(`${check.file}: ${rule.message}`);
    }
  }
}

for (const check of requiredImports) {
  const source = read(check.file);
  if (!check.pattern.test(source)) {
    failures.push(`${check.file}: ${check.message}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
