import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isImportDeclaration } from "typescript/unstable/ast";
import {
  API,
  SymbolFlags,
  isStringLiteralType,
  isUnionType,
} from "typescript/unstable/sync";

const MANIFEST_PATH = "test/public-api.json";

/**
 * @param {{ packageName: string; packageSubpaths: string[]; workdir: string }} options
 */
export function inspectPublicApi(options) {
  const importableSubpaths = options.packageSubpaths.filter(
    (subpath) => subpath !== "./package.json",
  );
  const specifiers = importableSubpaths.map((subpath) =>
    subpath === "." ? options.packageName : `${options.packageName}/${subpath.slice(2)}`,
  );
  const runtime = inspectRuntimeExports(options.workdir, importableSubpaths, specifiers);
  const declarations = inspectDeclarationExports(options.workdir, importableSubpaths, specifiers);
  const packageSubpaths = Object.fromEntries(
    options.packageSubpaths.map((subpath) => {
      if (subpath === "./package.json") return [subpath, { kind: "json" }];
      return [
        subpath,
        {
          runtime: runtime[subpath],
          types: declarations[subpath].types,
          errorCodes: declarations[subpath].errorCodes,
        },
      ];
    }),
  );
  return { packageSubpaths };
}

/**
 * @param {string} workdir
 * @param {string[]} subpaths
 * @param {string[]} specifiers
 */
function inspectRuntimeExports(workdir, subpaths, specifiers) {
  const script = `
    const subpaths = ${JSON.stringify(subpaths)};
    const specifiers = ${JSON.stringify(specifiers)};
    const surface = {};
    for (let index = 0; index < specifiers.length; index += 1) {
      surface[subpaths[index]] = Object.keys(await import(specifiers[index])).sort();
    }
    process.stdout.write(JSON.stringify(surface));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

/**
 * @param {string} workdir
 * @param {string[]} subpaths
 * @param {string[]} specifiers
 */
function inspectDeclarationExports(workdir, subpaths, specifiers) {
  const probePath = join(workdir, "public-api-surface.ts");
  writeFileSync(
    probePath,
    specifiers
      .map((specifier, index) => `import type * as surface${index} from ${JSON.stringify(specifier)};`)
      .join("\n"),
  );
  const api = new API({ cwd: workdir });
  const snapshot = api.updateSnapshot({ openFiles: [probePath] });
  try {
    const project = snapshot.getDefaultProjectForFile(probePath);
    const source = project?.program.getSourceFile(probePath);
    if (!project || !source) throw new Error("could not create the public API declaration probe");
    const imports = source.statements.filter(isImportDeclaration);
    const checker = project.checker;

    return Object.fromEntries(imports.map((declaration, index) => {
      const moduleSymbol = checker.getSymbolAtLocation(declaration.moduleSpecifier);
      if (!moduleSymbol) {
        throw new Error(`could not resolve declarations for ${specifiers[index]}`);
      }
      const types = [];
      const errorCodes = {};
      for (const exportedSymbol of checker.getExportsOfModule(moduleSymbol)) {
        const symbol =
          exportedSymbol.flags & SymbolFlags.Alias
            ? checker.getAliasedSymbol(exportedSymbol)
            : exportedSymbol;
        if (!(symbol.flags & SymbolFlags.Type)) continue;
        const name = exportedSymbol.name;
        types.push(name);
        if (!name.endsWith("ErrorCode")) continue;
        const declaredType = checker.getDeclaredTypeOfSymbol(symbol);
        const members = isUnionType(declaredType) ? declaredType.getTypes() : [declaredType];
        if (members.every(isStringLiteralType)) {
          errorCodes[name] = members.map((member) => member.value).sort();
        }
      }
      return [
        subpaths[index],
        {
          types: types.sort(),
          errorCodes: Object.fromEntries(
            Object.entries(errorCodes).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          ),
        },
      ];
    }));
  } finally {
    snapshot.dispose();
    api.close();
  }
}

/**
 * @param {ReturnType<typeof inspectPublicApi>} actual
 */
export function assertPublicApi(actual) {
  const expected = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const failures = [];
  compareNames(
    failures,
    "package subpath",
    "package.json exports",
    Object.keys(expected.packageSubpaths),
    Object.keys(actual.packageSubpaths),
  );

  for (const subpath of Object.keys(actual.packageSubpaths)) {
    const expectedEntry = expected.packageSubpaths[subpath];
    const actualEntry = actual.packageSubpaths[subpath];
    if (!expectedEntry || expectedEntry.kind === "json" || actualEntry.kind === "json") continue;
    compareNames(failures, "runtime export", subpath, expectedEntry.runtime, actualEntry.runtime);
    compareNames(failures, "type export", subpath, expectedEntry.types, actualEntry.types);
    const sharedErrorCodeTypes = Object.keys(expectedEntry.errorCodes).filter((typeName) =>
      Object.hasOwn(actualEntry.errorCodes, typeName),
    );
    for (const typeName of sharedErrorCodeTypes) {
      compareNames(
        failures,
        `error code in ${typeName}`,
        subpath,
        expectedEntry.errorCodes[typeName] ?? [],
        actualEntry.errorCodes[typeName] ?? [],
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "Public API surface changed:",
        ...failures.map((failure) => `- ${failure}`),
        "Remove accidental changes. If every change is deliberate, run `pnpm public-api:update` and review test/public-api.json before committing it.",
      ].join("\n"),
    );
  }
}

/**
 * @param {string[]} failures
 * @param {string} kind
 * @param {string} location
 * @param {string[]} expected
 * @param {string[]} actual
 */
function compareNames(failures, kind, location, expected, actual) {
  const expectedNames = new Set(expected);
  const actualNames = new Set(actual);
  for (const name of actualNames) {
    if (!expectedNames.has(name)) {
      failures.push(`${kind} appeared at ${location}: ${name} (the public API widened)`);
    }
  }
  for (const name of expectedNames) {
    if (!actualNames.has(name)) {
      failures.push(`${kind} vanished from ${location}: ${name} (existing consumers may break)`);
    }
  }
}

/**
 * @param {ReturnType<typeof inspectPublicApi>} surface
 */
export function writePublicApiManifest(surface) {
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(surface, null, 2)}\n`);
}
