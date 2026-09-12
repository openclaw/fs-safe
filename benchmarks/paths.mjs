import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function registerPaths({ api: a, workspace: w, register: add, contract, exclude, args, native }) {
  const input = path.join(w, "input.json");
  const error = Object.assign(new Error("synthetic"), { code: "ENOENT" });
  const simple = {
    assertNoNulPathInput: ["tree/nested/file"], hasNodeErrorCode: [error, "ENOENT"], isNodeError: [error],
    isNotFoundPathError: [error], isSymlinkOpenError: [error], isPathInside: [w, input],
    isPathRelativeEscape: ["tree/file"], isWithinDir: [w, input],
    normalizeWindowsPathForComparison: ["C:\\workspace\\tree\\file.json"],
    resolveSafeBaseDir: [w], resolveSafeRelativePath: [w, "tree/nested/file"], splitSafeRelativePath: ["tree/nested/file"],
    assertAbsolutePathInput: [input], assertNoUnsafeDeviceReadPath: [input], isUnsafeDeviceReadPath: [input], matchUnsafeDeviceReadPath: [input],
    assertNoWindowsNetworkPath: [input], basenameFromMediaSource: [pathToFileURL(input).href],
    hasEncodedFileUrlSeparator: ["file:///workspace/a%20b.json"], isWindowsDriveLetterPath: ["C:\\workspace\\file", "win32"],
    isWindowsNetworkPath: ["\\\\server\\share\\file", "win32"], safeFileURLToPath: [pathToFileURL(input).href], trySafeFileURLToPath: [pathToFileURL(input).href],
    safeDirName: ["package/module"], safePathSegmentHashed: ["ordinary-safe-name"], sanitizeUntrustedFileName: ["ordinary-safe-name.json", "fallback"],
    sanitizeTempFileName: ["ordinary-safe-name.json"], resolveRegularFileAppendFlags: [],
    sameFileIdentity: [{ dev: 1, ino: 123 }, { dev: 1, ino: 123 }],
    resolveSafeInstallDir: [{ baseDir: w, id: "module", invalidNameMessage: "invalid" }],
    buildRandomTempFilePath: [{ rootDir: w, prefix: "bench" }], resolveHomeRelativePath: [input],
    canUseRootFileOpen: [fs],
    matchRootFileOpenFailure: [{ ok: false, reason: "path", error }, { path: () => null, validation: () => null, io: () => null, fallback: () => null }],
    modeBits: [0o100600], formatOctal: [0o600], formatPosixMode: [0o100600],
    isGroupReadable: [0o600], isGroupWritable: [0o600], isWorldReadable: [0o600], isWorldWritable: [0o600],
    isHardlinkFallbackError: [Object.assign(new Error("synthetic"), { code: "EXDEV" })],
    categorizeFsSafeError: ["outside-workspace"],
  };
  for (const [name, values] of Object.entries(simple)) add(name, () => a[name](...values), { sync: true, batch: 100 });
  add("isPathInside/trailing-separator", () => a.isPathInside(`${w}${path.sep}`, input), {
    sync: true, batch: 100, verify: (result) => assert.equal(result, true),
  });
  add("FsSafeError", () => new a.FsSafeError("invalid-path", "synthetic"), { sync: true, batch: 100 });
  for (const name of ["safeRealpathSync", "safeStatSync", "pathExistsSync"]) add(name, () => a[name](input), { sync: true });
  for (const name of ["pathExists", "safeStat", "inspectPathPermissions"]) add(name, () => a[name](input));
  add("isPathInsideWithRealpath", () => a.isPathInsideWithRealpath(w, input), { sync: true });
  for (const name of ["findExistingAncestor", "canonicalPathFromExistingAncestor"]) add(name, () => a[name](input));
  for (const name of ["resolveAbsolutePathForRead", "resolveAbsolutePathForWrite"]) add(name, () => a[name](input));
  add("ensureAbsoluteDirectory", () => a.ensureAbsoluteDirectory(path.join(w, "tree")));
  add("assertCanonicalPathWithinBase", () => a.assertCanonicalPathWithinBase({ baseDir: w, candidatePath: path.join(w, "tree"), boundaryLabel: "benchmark" }));
  for (const name of ["assertNoSymlinkParents", "assertNoSymlinkParentsSync"]) add(name, () => a[name]({ rootDir: w, targetPath: input }), { sync: name.endsWith("Sync") });
  add("assertNoHardlinkedFinalPath", () => a.assertNoHardlinkedFinalPath({ filePath: input, root: w, boundaryLabel: "benchmark" }));
  const rootParams = { absolutePath: input, rootPath: w, boundaryLabel: "benchmark" };
  for (const name of ["resolveRootPath", "resolveRootPathSync", "assertNoPathAliasEscape"]) add(name, () => a[name](rootParams), { sync: name.endsWith("Sync") });
  add("resolvePathViaExistingAncestorSync", () => a.resolvePathViaExistingAncestorSync(input), { sync: true });
  for (const name of ["resolveLocalPathFromRootsSync", "readLocalFileFromRoots"]) add(name, () => a[name]({ filePath: input, roots: [w] }), { sync: name.endsWith("Sync") });
  const base = { rootDir: w, scopeLabel: "benchmark" };
  for (const name of ["resolvePathWithinRoot", "resolveWritablePathWithinRoot", "ensureDirectoryWithinRoot"]) add(name, () => a[name]({ ...base, requestedPath: name === "ensureDirectoryWithinRoot" ? "tree" : "input.json" }), { sync: name === "resolvePathWithinRoot" });
  for (const name of ["resolvePathsWithinRoot", "resolveExistingPathsWithinRoot", "resolveStrictExistingPathsWithinRoot"]) add(name, () => a[name]({ ...base, requestedPaths: ["input.json"] }), { sync: name === "resolvePathsWithinRoot" });
  add("pathScope", () => a.pathScope(w, { label: "benchmark" }), { sync: true, batch: 100 });
  const scope = a.pathScope(w, { label: "benchmark" });
  contract("PathScope", scope);
  for (const name of ["resolve", "resolveAll", "existing", "files", "writable", "ensureDir"]) add(`PathScope.${name}`, () => scope[name](["resolveAll", "existing", "files"].includes(name) ? ["input.json"] : name === "ensureDir" ? "tree" : "input.json"), { sync: name.startsWith("resolve") });
  add("getFsSafeNativeConfig", () => a.getFsSafeNativeConfig(), { sync: true, batch: 100 });
  add("configureFsSafeNative", () => a.configureFsSafeNative({ mode: args.mode }), { sync: true });
  add("getFsSafeLockConfig", () => a.getFsSafeLockConfig(), { sync: true, batch: 100 });
  add("configureFsSafeLocks", () => a.configureFsSafeLocks({}), { sync: true });
  exclude("configureFsSafePython", "Deprecated startup alias of configureFsSafeNative; warning side effect, not an I/O hot path.");
  for (const name of ["__setFsSafeTestHooksForTest", "getFsSafeTestHooks", "drainFileLockManagerForTest", "resetFileLockManagerForTest"]) exclude(name, "Test instrumentation; covered by the test suite, excluded from production timing.");
  const perms = await a.inspectPathPermissions(input);
  add("formatPermissionDetail", () => a.formatPermissionDetail("fixture.json", perms), { sync: true, batch: 100 });
  add("formatPermissionRemediation", () => a.formatPermissionRemediation({ targetPath: "fixture.json", perms, isDir: false, posixMode: 0o600 }), { sync: true, batch: 100 });
  const env = { USERNAME: "benchmark", USERDOMAIN: "FIXTURE", USERSID: "S-1-5-21-111-222-333-1001" };
  const aclOutput = "C:\\fixture.json S-1-5-18:(F)\n S-1-1-0:(R)";
  const entries = a.parseIcaclsOutput(aclOutput, "C:\\fixture.json");
  const summary = { ok: true, entries, ...a.summarizeWindowsAcl(entries, env) };
  add("parseIcaclsOutput", () => a.parseIcaclsOutput(aclOutput, "C:\\fixture.json"), { sync: true, batch: 100 });
  add("summarizeWindowsAcl", () => a.summarizeWindowsAcl(entries, env), { sync: true, batch: 100 });
  add("formatWindowsAclSummary", () => a.formatWindowsAclSummary(summary), { sync: true, batch: 100 });
  add("resolveWindowsUserPrincipal", () => a.resolveWindowsUserPrincipal(env), { sync: true, batch: 100 });
  for (const name of ["createIcaclsResetCommand", "formatIcaclsResetCommand"]) add(name, () => a[name]("C:\\fixture.json", { isDir: false, env }), { sync: true, batch: 100 });
  add("inspectWindowsAcl", () => a.inspectWindowsAcl(input), { divisor: 100, skip: process.platform !== "win32" ? "Windows live ACL inspection requires Windows." : undefined, verify: (r) => assert(r.ok) });
  add("readOwnerAndDacl", () => a.readOwnerAndDacl(input), { sync: true, skip: process.platform !== "win32" || !native ? "Requires Windows native binding; no unsupported-platform timing substituted." : undefined });
  add("createPrivateDirectory", () => a.createPrivateDirectory(path.join(w, "private-dir")), {
    skip: process.platform !== "win32" || !native ? "Requires Windows native binding." : undefined,
    after: () => fs.rmdirSync(path.join(w, "private-dir")),
  });
  add("createAsyncLock", () => a.createAsyncLock(), { sync: true, batch: 100 });
  const lock = a.createAsyncLock();
  add("createAsyncLock/call", () => lock(async () => 1));
  add("withTimeout", () => a.withTimeout(Promise.resolve(1), 1000, "benchmark"));
  // Measure admission without sending files to the user's real Trash.
  add("movePathToTrash/rejection", () => a.movePathToTrash(input, { allowedRoots: [path.join(w, "tree")] }), {
    expectError: true, verify: (error) => assert.match(error.message, /outside allowed roots/),
  });
}
