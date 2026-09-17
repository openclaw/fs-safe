import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

export const PNPM_WORKSPACE_STATE = ".pnpm-workspace-state-v1.json";
export const PNPM_TASK_STATE = ".pnpm-task-run-state-v1";
// Reviewed pnpm 11.25.0: pnpm11/workspace/state/src/{createWorkspaceState,types}.ts
// and pnpm11/exec/commands/src/taskRunState.ts at this immutable upstream commit.
export const PNPM_METADATA_SOURCE = "6d90c71efdffbc909b499490b64c66badc720327";

function jsonObject(bytes, label, pretty = true) {
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.equal(text.trimEnd(), JSON.stringify(value, null, pretty ? 2 : undefined),
    `${label} is not the supported unambiguous JSON encoding`);
  return value;
}

function digest(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function exactKeys(value, required, optional, label) {
  const keys = Object.keys(value);
  assert(required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key)), `${label} fields are unsupported`);
}

export function canonicalPnpmWorkspaceState(bytes, checkout, verifyProject) {
  const state = jsonObject(bytes, "pnpm workspace state");
  exactKeys(state, ["lastValidatedTimestamp", "projects", "pnpmfiles", "settings", "filteredInstall"],
    ["configDependencies"], "pnpm workspace state");
  assert(Number.isSafeInteger(state.lastValidatedTimestamp) && state.lastValidatedTimestamp > 0,
    "pnpm workspace validation timestamp is invalid");
  assert(state.projects && typeof state.projects === "object" && !Array.isArray(state.projects),
    "pnpm workspace projects are invalid");
  assert(state.settings && typeof state.settings === "object" && !Array.isArray(state.settings),
    "pnpm workspace settings are invalid");
  assert(Array.isArray(state.pnpmfiles) && state.pnpmfiles.every(file => typeof file === "string"),
    "pnpm workspace pnpmfiles are invalid");
  assert.equal(typeof state.filteredInstall, "boolean", "pnpm workspace filteredInstall is invalid");
  if (Object.hasOwn(state, "configDependencies")) {
    assert(state.configDependencies && typeof state.configDependencies === "object" &&
      !Array.isArray(state.configDependencies), "pnpm workspace configDependencies are invalid");
  }
  assert(path.isAbsolute(checkout) && path.resolve(checkout) === checkout, "workspace checkout is not absolute and normalized");
  assert.equal(typeof verifyProject, "function", "workspace projects require physical-directory verification");
  const projects = Object.entries(state.projects).map(([root, project]) => {
    assert(path.isAbsolute(root) && path.resolve(root) === root && !/[\u0000-\u001f]/u.test(root),
      "pnpm workspace project path is not absolute and normalized");
    const relative = path.relative(checkout, root);
    assert(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      "pnpm workspace project escapes its checkout");
    assert(project && typeof project === "object" && !Array.isArray(project), "pnpm workspace project metadata is invalid");
    exactKeys(project, [], ["name", "version"], "pnpm workspace project");
    for (const value of Object.values(project)) assert(typeof value === "string", "pnpm workspace project field is invalid");
    verifyProject(root);
    return [relative === "" ? "." : relative.split(path.sep).join("/"), project];
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  assert(projects.length > 0 && projects.some(([root]) => root === "."), "pnpm workspace root project is missing");
  assert.equal(new Set(projects.map(([root]) => process.platform === "win32" ? root.toLowerCase() : root)).size,
    projects.length, "pnpm workspace project aliases collide");
  return { ...digest({ ...state, lastValidatedTimestamp: "<validation-time>", projects: Object.fromEntries(projects) }),
    lastValidatedTimestamp: state.lastValidatedTimestamp,
    projectRoots: Object.keys(state.projects).sort() };
}

// A successful pinned-pnpm task run leaves latest.json plus a zero-byte finished
// marker, deleting its journal/published marker. Accept only that quiescent shape.
// These are raw operational receipts, not cross-install dependency identity.
// pnpm hashes checkout-absolute extraBinPaths into invocation; its preimage is
// not persisted. Never infer or rewrite that preimage from an opaque hash.
export function canonicalPnpmTaskState(files) {
  assert(Array.isArray(files) && files.length >= 2, "pnpm task state is incomplete");
  const names = files.map(file => file.path);
  assert.equal(new Set(names).size, names.length, "pnpm task state paths are duplicated");
  const latestFile = files.find(file => file.path === "latest.json");
  assert(latestFile, "pnpm task latest header is missing");
  const latest = jsonObject(latestFile.bytes, "pnpm task latest header", false);
  exactKeys(latest, ["version", "invocation", "run"], [], "pnpm task header");
  assert.equal(latest.version, 1, "pnpm task version is unsupported");
  const invocationPattern = /^[0-9a-f]{64}$/u;
  const runPattern = /^[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const validRun = value => runPattern.test(value) && Number.parseInt(value.slice(0, 12), 16) > 0;
  assert(invocationPattern.test(latest.invocation) && validRun(latest.run), "pnpm task header identity is invalid");
  const completed = new Map();
  for (const file of files.filter(file => file.path !== "latest.json")) {
    const match = /^([0-9a-f]{64})\.(.+)\.finished$/u.exec(file.path);
    assert(match && validRun(match[2]), "pnpm task state is unfinished or unsupported");
    assert.equal(file.bytes.length, 0, "pnpm finished marker must be empty");
    assert(!completed.has(match[1]), "pnpm task has ambiguous completed generations");
    completed.set(match[1], match[2]);
  }
  assert.equal(completed.get(latest.invocation), latest.run, "pnpm task latest header lacks its finished marker");
  const records = files.map(file => ({ path: file.path, type: "file", size: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex") }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { records, latest: { ...latest }, completedInvocations: [...completed.keys()].sort() };
}

export function canonicalPathPrefixExecutionIdentity(input, checkout, verifyPath, pathApi = path) {
  exactKeys(input, ["schemaVersion", "packageManager", "commands", "taskPlan", "scripts", "settings", "source", "files"],
    [], "independent execution identity");
  assert.equal(input.schemaVersion, 1, "execution identity version is unsupported");
  assert.equal(input.packageManager, "pnpm@11.25.0", "execution package manager is unsupported");
  assert(pathApi.isAbsolute(checkout) && pathApi.resolve(checkout) === checkout, "execution checkout is not absolute and normalized");
  assert.equal(typeof verifyPath, "function", "execution paths require physical verification");
  const localPath = (actual, relative) => {
    const expected = pathApi.join(checkout, ...relative.split("/").filter(Boolean));
    assert.equal(actual, expected, "execution path is not the declared checkout-local path");
    assert.equal(pathApi.resolve(actual), actual, "execution path is not normalized");
    verifyPath(actual);
    return relative === "" ? "<checkout>" : `<checkout>/${relative}`;
  };
  const expectedCommands = [
    ["pnpm", "--dir", checkout, "install", "--frozen-lockfile"],
    ["pnpm", "--dir", checkout, "build"],
    ["pnpm", "--dir", checkout, "native:build"],
  ];
  assert.deepEqual(input.commands, expectedCommands, "execution command plan differs from the reviewed workflow");
  const root = localPath(checkout, "");
  const commands = input.commands.map(argv => argv.map((value, index) => index === 2 ? root : value));
  exactKeys(input.taskPlan, ["command", "params", "project", "packageName"], [], "execution task plan");
  assert.equal(input.taskPlan.command, "run", "execution task command is unsupported");
  assert.deepEqual(input.taskPlan.params, ["build"], "execution task arguments are unsupported");
  assert.equal(input.taskPlan.packageName, "@openclaw/fs-safe-native-build", "execution task package is unsupported");
  const taskPlan = { ...input.taskPlan, project: localPath(input.taskPlan.project, "native") };
  exactKeys(input.scripts, ["root", "native"], [], "execution scripts");
  for (const scripts of Object.values(input.scripts)) {
    assert(scripts && typeof scripts === "object" && !Array.isArray(scripts), "execution scripts must be objects");
    assert(typeof scripts.build === "string" && scripts.build.length > 0, "execution build script is missing");
    for (const value of Object.values(scripts)) assert(typeof value === "string", "execution script must be text");
  }
  assert.equal(input.scripts.root["native:build"], "pnpm --filter @openclaw/fs-safe-native-build build",
    "execution native selector differs from the reviewed workflow");
  exactKeys(input.settings, ["extraBinPaths", "modulesDir", "nodeOptions", "workspaceStateHash", "modulesStateHash"],
    [], "execution settings");
  assert(Array.isArray(input.settings.extraBinPaths) && input.settings.extraBinPaths.length === 1,
    "execution extraBinPaths must contain exactly the pinned workspace bin directory");
  const extraBinPaths = [localPath(input.settings.extraBinPaths[0], "node_modules/.bin")];
  assert.equal(input.settings.modulesDir, "node_modules", "execution modules directory is unsupported");
  assert(typeof input.settings.nodeOptions === "string" && !/[\u0000\r\n]/u.test(input.settings.nodeOptions),
    "execution node options are malformed");
  for (const key of ["workspaceStateHash", "modulesStateHash"]) {
    assert(/^[0-9a-f]{64}$/u.test(input.settings[key]), `execution ${key} is invalid`);
  }
  exactKeys(input.source, ["commit", "tree"], [], "execution source");
  for (const value of Object.values(input.source)) assert(/^[0-9a-f]{40}$/u.test(value), "execution source identity is invalid");
  const expectedFiles = ["package.json", "native/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  assert(Array.isArray(input.files) && input.files.length === expectedFiles.length, "execution source file inventory mismatch");
  const files = input.files.map((file, index) => {
    exactKeys(file, ["path", "sha256", "size"], [], "execution source file");
    assert(/^[0-9a-f]{64}$/u.test(file.sha256) && Number.isSafeInteger(file.size) && file.size > 0,
      "execution source file receipt is invalid");
    return { ...file, path: localPath(file.path, expectedFiles[index]) };
  });
  const inputs = { ...input, commands, taskPlan, files, settings: { ...input.settings, extraBinPaths } };
  return { schemaVersion: 1, model: "reviewed-workflow-build-contract-v1", ...digest(inputs), inputs };
}

export function validatePathPrefixExecutionReceipt(receipt) {
  exactKeys(receipt, ["raw", "canonical"], [], "execution receipt");
  const checkout = receipt.raw?.commands?.[0]?.[2];
  assert.equal(typeof checkout, "string", "execution receipt checkout is missing");
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/u.test(checkout) ? path.win32 : path.posix;
  // Recompute downloaded data using the producing platform's path rules. The
  // producer performs physical checks; downloaded checkouts do not exist here.
  const expected = canonicalPathPrefixExecutionIdentity(receipt.raw, checkout, () => {}, pathApi);
  assert.deepEqual(receipt.canonical, expected, "execution receipt canonical binding mismatch");
  return expected;
}

export function canonicalPnpmDependencyRecords(records, replacements, taskState, executionIdentity) {
  assert.deepEqual([...replacements.keys()].sort(), [".modules.yaml", PNPM_WORKSPACE_STATE].sort(),
    "canonical dependency replacement inventory mismatch");
  assert.equal(executionIdentity?.model, "reviewed-workflow-build-contract-v1", "independent execution identity is missing");
  assert.equal(taskState.completedInvocations.length, 1, "reviewed build requires exactly one completed native invocation");
  const operational = records.filter(record => record.path.startsWith(`${PNPM_TASK_STATE}/`) && record.path !== `${PNPM_TASK_STATE}/`);
  assert.deepEqual(operational.map(record => ({ ...record, path: record.path.slice(PNPM_TASK_STATE.length + 1) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0), taskState.records,
  "raw task receipt inventory differs from validated lifecycle evidence");
  assert.deepEqual(records.filter(record => record.path === `${PNPM_TASK_STATE}/`),
    [{ path: `${PNPM_TASK_STATE}/`, type: "directory" }], "raw task directory inventory mismatch");
  const normalized = [
    ...records.filter(record => !record.path.startsWith(`${PNPM_TASK_STATE}/`))
      .map(record => replacements.get(record.path) ?? record),
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assert.equal(normalized.length + operational.length + 1, records.length, "canonical dependency metadata inventory changed");
  assert.equal(new Set(normalized.map(record => record.path)).size, normalized.length,
    "canonical dependency paths collide");
  return normalized;
}

// pnpm 11 writes this .yaml-named file as JSON. Fail closed on any other encoding
// rather than attempting a lossy YAML rewrite or dropping unknown fields.
export function canonicalPnpmModules(bytes, checkout) {
  const text = bytes.toString("utf8");
  const metadata = JSON.parse(text);
  assert(metadata && typeof metadata === "object" && !Array.isArray(metadata),
    "pnpm modules metadata must be an object");
  assert.equal(text.trimEnd(), JSON.stringify(metadata, null, 2),
    "pnpm modules metadata is not the supported unambiguous JSON encoding");
  assert(typeof metadata.prunedAt === "string" && Number.isFinite(Date.parse(metadata.prunedAt)),
    "pnpm modules prunedAt is invalid");
  assert.equal(typeof metadata.virtualStoreDir, "string", "pnpm virtual store path is missing");
  const expected = path.resolve(checkout, "node_modules", ".pnpm");
  const actual = path.resolve(checkout, "node_modules", metadata.virtualStoreDir);
  const key = value => process.platform === "win32" ? value.toLowerCase() : value;
  assert.equal(key(actual), key(expected), "pnpm virtual store escapes its expected installation");
  const canonical = { ...metadata, prunedAt: "<per-install-pruned-at>",
    virtualStoreDir: "<checkout>/node_modules/.pnpm" };
  const canonicalBytes = Buffer.from(JSON.stringify(canonical));
  return {
    sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
    size: canonicalBytes.length,
    prunedAt: metadata.prunedAt,
    virtualStoreDir: metadata.virtualStoreDir,
  };
}
