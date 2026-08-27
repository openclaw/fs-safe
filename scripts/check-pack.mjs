import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { normalizePackResult } from "./npm-pack-result.mjs";
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

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  if (process.platform !== "win32") {
    try {
      candidates.push(realpathSync(execFileSync("which", ["npm"], { encoding: "utf8" }).trim()));
    } catch {
      // The standard bundled paths remain valid on supported non-Windows Node installations.
    }
  }
  const npmCli = candidates.find(
    (candidate) => candidate && basename(candidate) === "npm-cli.js" && existsSync(candidate),
  );
  if (!npmCli) {
    throw new Error("could not resolve npm-cli.js from the current Node installation");
  }
  return npmCli;
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

  const forbidden = [...paths].filter((path) =>
    /^(?:\.agents|\.github|scripts|src|test)\//.test(path),
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
