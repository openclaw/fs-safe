import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNpmCli } from "./npm-cli.mjs";
import { normalizePackResult } from "./npm-pack-result.mjs";
import { validateArchiveWasm } from "./archive-wasm-build-tools.mjs";
import { WINDOWS_COMMAND_ASSETS } from "./windows-command-assets.mjs";
import {
  assertPublicApi,
  inspectPublicApi,
  writePublicApiManifest,
} from "./public-api-surface.mjs";

const workdir = mkdtempSync(join(tmpdir(), "fs-safe-pack-"));
const npmCommand = resolveNpmCli();
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
);

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
function runNpm(args, options) {
  return execFileSync(process.execPath, [npmCommand, ...args], {
    ...options,
    env: npmEnv,
  });
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function collectExportTargets(value) {
  if (typeof value === "string") {
    return value.startsWith("./") ? [value.slice(2)] : [];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap(collectExportTargets);
}

try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const output = runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", workdir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const { filename, files } = normalizePackResult(JSON.parse(output), pkg.name);
  const paths = new Set(files.map((file) => file.path));
  const expected = new Set([
    "CHANGELOG.md",
    "dist/archive-parser.wasm",
    ...WINDOWS_COMMAND_ASSETS.map((name) => `dist/${name}`),
    "docs/assets/readme-banner.jpg",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "package.json",
    ...collectExportTargets(pkg.exports),
  ]);
  const missing = [...expected].filter((path) => !paths.has(path)).toSorted();
  if (missing.length > 0) {
    throw new Error(`packed package is missing: ${missing.join(", ")}`);
  }

  // Declaration maps target src/, which the published package intentionally excludes.
  const forbidden = [...paths].filter((path) =>
    /^(?:\.agents|\.github|scripts|src|test)\//.test(path) || path.endsWith(".d.ts.map"),
  );
  if (forbidden.length > 0) {
    throw new Error(`packed package contains repository-only files: ${forbidden.join(", ")}`);
  }
  if (pkg.name !== "@openclaw/fs-safe") {
    throw new Error(`unexpected package name: ${pkg.name}`);
  }

  const archive = join(workdir, filename);
  writeFileSync(join(workdir, "package.json"), '{"private":true,"type":"module"}\n');
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", archive], {
    cwd: workdir,
    encoding: "utf8",
    stdio: "pipe",
  });
  validateArchiveWasm(readFileSync(join(workdir, "node_modules", "@openclaw", "fs-safe", "dist", "archive-parser.wasm")));
  for (const name of WINDOWS_COMMAND_ASSETS) {
    const installed = join(workdir, "node_modules", "@openclaw", "fs-safe", "dist", name);
    if (!readFileSync(installed).equals(readFileSync(new URL(`../src/${name}`, import.meta.url)))) {
      throw new Error(`packaged Windows command asset differs from its source: ${name}`);
    }
  }

  const specifiers = Object.keys(pkg.exports)
    .filter((subpath) => subpath !== "./package.json")
    .map((subpath) => (subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`));
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)));`,
    ],
    { cwd: workdir, stdio: "pipe" },
  );
  const guestSmokeArgs = [join(import.meta.dirname, "guest-package-smoke.mjs"), workdir];
  if (process.argv.includes("--guest-cross-device")) guestSmokeArgs.push("--cross-device");
  execFileSync(process.execPath, guestSmokeArgs, {
    cwd: workdir,
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    [join(import.meta.dirname, "directory-receipt-package-smoke.mjs"), workdir],
    { cwd: workdir, stdio: "inherit" },
  );
  const publicApi = inspectPublicApi({
    packageName: pkg.name,
    packageSubpaths: Object.keys(pkg.exports),
    workdir,
  });
  if (process.argv.includes("--update-public-api")) {
    writePublicApiManifest(publicApi);
  } else {
    assertPublicApi(publicApi);
  }
} finally {
  rmSync(workdir, { force: true, recursive: true });
}
