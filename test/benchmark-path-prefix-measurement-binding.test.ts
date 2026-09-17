import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PNPM_METADATA_SOURCE, PNPM_TASK_STATE, PNPM_WORKSPACE_STATE,
  canonicalPathPrefixExecutionIdentity, canonicalPnpmDependencyRecords, canonicalPnpmModules,
  canonicalPnpmTaskState, canonicalPnpmWorkspaceState, validatePathPrefixExecutionReceipt,
} from "../benchmarks/method-audit-dependency-identity.mjs";
import { assertPathPrefixSourceLifecycle } from "../benchmarks/path-prefix-source-binding.mjs";
import { assertStableSnapshots, digestJson } from "../benchmarks/method-audit-plan.mjs";

const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const invocation = "a".repeat(64);
const firstRun = "01994abcd000-00000000-0000-4000-8000-000000000001";
const laterRun = "01994bcde111-11111111-1111-4111-9111-111111111111";
function workspaceState(root: string, timestamp = 1789516800000) {
  return {
    lastValidatedTimestamp: timestamp,
    projects: {
      [root]: { name: "@openclaw/fs-safe", version: "0.13.1" },
      [path.join(root, "native")]: { name: "@openclaw/fs-safe-native-build", version: "0.13.1" },
      [path.join(root, "packages", "linux-x64-gnu")]: { name: "@openclaw/fs-safe-linux-x64-gnu", version: "0.13.1" },
    },
    pnpmfiles: [] as string[],
    settings: { allowBuilds: { esbuild: true }, autoInstallPeers: true, catalogs: {},
      dedupeDirectDeps: false, dedupeInjectedDeps: true, dedupePeerDependents: true, dedupePeers: false,
      dev: true, excludeLinksFromLockfile: false, hoistPattern: ["*"], hoistWorkspacePackages: true,
      injectWorkspacePackages: false, linkWorkspacePackages: true, minimumReleaseAge: 2880,
      minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: true, nodeLinker: "isolated",
      optional: true, peersSuffixMaxLength: 1000, preferWorkspacePackages: false, production: true,
      publicHoistPattern: [], workspacePackagePatterns: ["native", "packages/*"] },
    filteredInstall: false,
    configDependencies: { "example-config": "1.0.0+sha512-example" },
  };
}
function taskState(run = firstRun, identity = invocation) {
  return [
    { path: "latest.json", bytes: Buffer.from(JSON.stringify({ version: 1, invocation: identity, run })) },
    { path: `${identity}.${run}.finished`, bytes: Buffer.alloc(0) },
  ];
}
function rawFile(pathname: string, bytes: Buffer) {
  return { path: pathname, type: "file", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}
function executionInput(root: string, workspaceStateHash: string, modulesStateHash: string) {
  return {
    schemaVersion: 1, packageManager: "pnpm@11.25.0",
    commands: [["pnpm", "--dir", root, "install", "--frozen-lockfile"],
      ["pnpm", "--dir", root, "build"], ["pnpm", "--dir", root, "native:build"]],
    taskPlan: { command: "run", params: ["build"], project: path.join(root, "native"), packageName: "@openclaw/fs-safe-native-build" },
    scripts: { root: { build: "node scripts/prepack-build.mjs", "native:build": "pnpm --filter @openclaw/fs-safe-native-build build" },
      native: { build: "napi build --platform --release && node ../scripts/stage-host-native.mjs" } },
    settings: { extraBinPaths: [path.join(root, "node_modules", ".bin")], modulesDir: "node_modules", nodeOptions: "",
      workspaceStateHash, modulesStateHash },
    source: { commit: "1".repeat(40), tree: "2".repeat(40) },
    files: ["package.json", "native/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
      .map(name => ({ path: path.join(root, ...name.split("/")), sha256: "c".repeat(64), size: 100 })),
  };
}
function rawPnpmInvocation(root: string) {
  // Pinned TaskRunStateContext input shape: only extra-bin-paths changes here.
  return {
    command: "run", params: ["build"],
    settings: [
      `extra-bin-paths=${JSON.stringify([path.join(root, "node_modules", ".bin")])}`,
      "extra-env=[]", "modules-dir=node_modules", "node-experimental-package-map=false", "node-options=",
      "user-agent=pnpm/11.25.0 npm/? node/v22.18.0 linux x64", "enable-pre-post-scripts=true",
      "script-shell=", "scripts-prepend-node-path=false", "shell-emulator=false",
    ].sort(),
    tasks: [{ project: "native", task: "build", scripts: [{ name: "build",
      commands: ["napi build --platform --release && node ../scripts/stage-host-native.mjs"] }],
    requested: true, dependencies: [] }],
  };
}
function dependencyFixture(root: string, timestamp: number, run: string) {
  const modules = modulesMetadata(root, { prunedAt: new Date(timestamp).toUTCString() });
  const workspace = jsonBytes(workspaceState(root, timestamp));
  const rawInvocation = rawPnpmInvocation(root);
  const rawInvocationHash = createHash("sha256").update(JSON.stringify(rawInvocation)).digest("hex");
  const tasks = taskState(run, rawInvocationHash);
  const modulesIdentity = canonicalPnpmModules(modules, root);
  const projectsVerified: string[] = [];
  const workspaceIdentity = canonicalPnpmWorkspaceState(workspace, root,
    (project: string) => projectsVerified.push(project));
  const taskIdentity = canonicalPnpmTaskState(tasks);
  const executionRaw = executionInput(root, workspaceIdentity.sha256, modulesIdentity.sha256);
  const executionIdentity = { raw: executionRaw,
    canonical: canonicalPathPrefixExecutionIdentity(executionRaw, root, () => {}) };
  const records: Array<{ path: string; type: string; sha256?: string; size?: number }> = [
    rawFile(".modules.yaml", modules), rawFile(PNPM_WORKSPACE_STATE, workspace),
    { path: `${PNPM_TASK_STATE}/`, type: "directory" },
    ...tasks.map(file => rawFile(`${PNPM_TASK_STATE}/${file.path}`, file.bytes)),
    rawFile("example/package.json", Buffer.from('{"name":"example","version":"1.0.0"}'))];
  const replacements = new Map([
    [".modules.yaml", { path: ".modules.yaml", type: "file", sha256: modulesIdentity.sha256, size: modulesIdentity.size }],
    [PNPM_WORKSPACE_STATE, { path: PNPM_WORKSPACE_STATE, type: "file", sha256: workspaceIdentity.sha256, size: workspaceIdentity.size }],
  ]);
  const canonical = canonicalPnpmDependencyRecords(records, replacements, taskIdentity, executionIdentity.canonical);
  return { records, replacements, taskIdentity, projectsVerified, executionIdentity, rawInvocation, rawInvocationHash,
    canonical, canonicalHash: digestJson({ dependencies: canonical, execution: executionIdentity.canonical }),
    snapshot: { planHash: "frozen", harness: {}, checkouts: {}, builds: { candidate: {
      dependencySnapshot: { hash: digestJson(records), files: records, executionIdentity,
        workspaceMetadata: { ...rawFile(PNPM_WORKSPACE_STATE, workspace),
          lastValidatedTimestamp: timestamp, projectRoots: workspaceIdentity.projectRoots },
        taskMetadata: { sourceCommit: PNPM_METADATA_SOURCE, latest: taskIdentity.latest,
          files: tasks.map(file => rawFile(file.path, file.bytes)) } },
    } } },
  };
}

function modulesMetadata(root: string, overrides = {}) {
  return Buffer.from(`${JSON.stringify({
    hoistedDependencies: { "example@1.0.0": { example: "public" } },
    layoutVersion: 5,
    prunedAt: "Wed, 16 Sep 2026 00:00:00 GMT",
    storeDir: "/shared/pnpm/store",
    virtualStoreDir: path.join(root, "node_modules", ".pnpm"),
    ...overrides,
  }, null, 2)}\n`);
}

const expected = {
  commit: "1".repeat(40), tree: "2".repeat(40),
  pathPrefixSourceBlob: "3".repeat(40), pathPrefixSourceHash: "4".repeat(64),
};
function sourceBinding() {
  return {
    commit: expected.commit, tree: expected.tree, status: "",
    source: { blob: expected.pathPrefixSourceBlob, sha256: expected.pathPrefixSourceHash,
      size: 10, dev: "1", ino: "2", nlink: "1", mtimeNs: "3", ctimeNs: "4" },
  };
}

describe("path-prefix measurement identity", () => {
  it("binds a complete dependency fixture across different-length roots, timestamps and task UUIDs", () => {
    const first = dependencyFixture(path.resolve("a"), 1789516800000, firstRun);
    const second = dependencyFixture(path.resolve("much-longer-independent-checkout"), 1789520400000, laterRun);
    expect(first.canonical).toEqual(second.canonical);
    expect(first.canonicalHash).toBe(second.canonicalHash);
    expect(first.rawInvocationHash).not.toBe(second.rawInvocationHash);
    expect(first.taskIdentity.latest.invocation).toBe(first.rawInvocationHash);
    expect(second.taskIdentity.latest.invocation).toBe(second.rawInvocationHash);
    expect(first.executionIdentity.canonical).toEqual(second.executionIdentity.canonical);
    expect(first.rawInvocation.settings.filter(setting => !setting.startsWith("extra-bin-paths=")))
      .toEqual(second.rawInvocation.settings.filter(setting => !setting.startsWith("extra-bin-paths=")));
    expect(digestJson(first.records)).not.toBe(digestJson(second.records));
    expect(first.records.find(file => file.path === PNPM_WORKSPACE_STATE)!.size)
      .not.toBe(second.records.find(file => file.path === PNPM_WORKSPACE_STATE)!.size);
    expect(first.projectsVerified).toHaveLength(3);
    expect(first.taskIdentity.latest.run).not.toBe(second.taskIdentity.latest.run);
    expect(first.canonical).toHaveLength(first.records.length - 3);
    expect(first.canonical.find(file => file.path === "example/package.json"))
      .toEqual(first.records.find(file => file.path === "example/package.json"));
    const changedPackage = structuredClone(first.records);
    changedPackage.find(file => file.path === "example/package.json")!.sha256 = "b".repeat(64);
    expect(canonicalPnpmDependencyRecords(changedPackage, first.replacements, first.taskIdentity, first.executionIdentity.canonical))
      .not.toEqual(first.canonical);
    expect(() => canonicalPnpmDependencyRecords([...first.records,
      rawFile(`${PNPM_TASK_STATE}/unknown`, Buffer.alloc(0))], first.replacements, first.taskIdentity, first.executionIdentity.canonical))
      .toThrow("inventory");
  });

  it("preserves every meaningful workspace setting, project and pnpmfile", () => {
    const root = path.resolve("candidate");
    const original = workspaceState(root);
    const normalize = (value: unknown) => canonicalPnpmWorkspaceState(jsonBytes(value), root, () => {}).sha256;
    const originalHash = normalize(original);
    for (const mutate of [
      (state: any) => { state.settings.minimumReleaseAge = 60; },
      (state: any) => { state.settings.allowBuilds.esbuild = false; },
      (state: any) => { state.settings.supportedArchitectures = { os: ["linux"] }; },
      (state: any) => { state.projects[root].version = "0.13.2"; },
      (state: any) => { delete state.projects[path.join(root, "native")]; },
      (state: any) => { state.pnpmfiles = ["reviewed-hook.cjs"]; },
      (state: any) => { state.filteredInstall = true; },
      (state: any) => { state.configDependencies["example-config"] = "2.0.0+sha512-other"; },
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      expect(normalize(changed)).not.toBe(originalHash);
    }
  });

  it("binds independent command, script, setting and source inputs without decoding raw invocation hashes", () => {
    const root = path.resolve("candidate");
    const original = executionInput(root, "a".repeat(64), "b".repeat(64));
    const canonical = canonicalPathPrefixExecutionIdentity(original, root, () => {});
    expect(() => validatePathPrefixExecutionReceipt({ raw: original, canonical })).not.toThrow();
    for (const mutate of [
      (value: any) => { value.scripts.native.build += " --debug"; },
      (value: any) => { value.scripts.root.build = "node scripts/other-build.mjs"; },
      (value: any) => { value.settings.nodeOptions = "--conditions=development"; },
      (value: any) => { value.settings.workspaceStateHash = "c".repeat(64); },
      (value: any) => { value.files[2].sha256 = "d".repeat(64); },
      (value: any) => { value.source.tree = "e".repeat(40); },
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      expect(canonicalPathPrefixExecutionIdentity(changed, root, () => {}).sha256).not.toBe(canonical.sha256);
      expect(() => validatePathPrefixExecutionReceipt({ raw: changed, canonical })).toThrow("canonical binding");
    }
    for (const mutate of [
      (value: any) => { value.commands[1][3] = "exec"; },
      (value: any) => { value.commands[0][2] = path.resolve("outside"); },
      (value: any) => { value.taskPlan.command = "exec"; },
      (value: any) => { value.taskPlan.params = ["build", "--unsafe-extra-option"]; },
      (value: any) => { value.taskPlan.project = path.resolve("other-native"); },
      (value: any) => { value.settings.extraBinPaths = [path.resolve("outside", "node_modules", ".bin")]; },
      (value: any) => { value.settings.extraBinPaths.push(path.join(root, "tools")); },
      (value: any) => { value.settings.extraBinPaths = [`${root}${path.sep}native${path.sep}..${path.sep}node_modules${path.sep}.bin`]; },
      (value: any) => { value.settings.extraBinPaths = "not-an-array"; },
      (value: any) => { value.settings.unrecognizedPath = path.join(root, "tools"); },
      (value: any) => { value.files[0].path = path.resolve("outside", "package.json"); },
      (value: any) => { value.scripts.native.build = ["napi", "build"]; },
      (value: any) => { value.unrecognized = true; },
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      expect(() => canonicalPathPrefixExecutionIdentity(changed, root, () => {})).toThrow();
    }
    expect(() => canonicalPathPrefixExecutionIdentity(original, root,
      () => { throw new Error("physical path mismatch"); })).toThrow("physical");
  });

  it("requires the raw operational inventory independently of canonical execution equality", () => {
    const fixture = dependencyFixture(path.resolve("candidate"), 1789516800000, firstRun);
    const changedTaskBytes = structuredClone(fixture.records);
    changedTaskBytes.find(file => file.path === `${PNPM_TASK_STATE}/latest.json`)!.sha256 = "d".repeat(64);
    expect(() => canonicalPnpmDependencyRecords(changedTaskBytes, fixture.replacements,
      fixture.taskIdentity, fixture.executionIdentity.canonical)).toThrow("raw task receipt inventory");
    expect(() => canonicalPnpmDependencyRecords(fixture.records, fixture.replacements,
      fixture.taskIdentity, undefined)).toThrow("independent execution");
    const extraInvocation = canonicalPnpmTaskState([
      ...taskState(firstRun, fixture.rawInvocationHash), taskState(laterRun, "b".repeat(64))[1]!,
    ]);
    expect(() => canonicalPnpmDependencyRecords(fixture.records, fixture.replacements,
      extraInvocation, fixture.executionIdentity.canonical)).toThrow("exactly one");
  });

  it("rejects malformed, out-of-root, aliased or unverified workspace projects", () => {
    const root = path.resolve("candidate");
    for (const invalid of ["relative/project", path.resolve("candidate-sibling"),
      `${root}${path.sep}..${path.sep}outside`, `${root}${path.sep}native${path.sep}`, `${root}\0bad`]) {
      const state = workspaceState(root);
      state.projects[invalid] = { name: "bad", version: "1" };
      expect(() => canonicalPnpmWorkspaceState(jsonBytes(state), root, () => {})).toThrow();
    }
    for (const invalidTimestamp of [0, -1, 1.5, "1789516800000", null]) {
      const state = { ...workspaceState(root), lastValidatedTimestamp: invalidTimestamp };
      expect(() => canonicalPnpmWorkspaceState(jsonBytes(state), root, () => {})).toThrow();
    }
    expect(() => canonicalPnpmWorkspaceState(jsonBytes(workspaceState(root)), root, undefined)).toThrow();
    expect(() => canonicalPnpmWorkspaceState(jsonBytes(workspaceState(root)), root,
      () => { throw new Error("project is a symlink or missing"); })).toThrow("symlink");
    expect(() => canonicalPnpmWorkspaceState(Buffer.from('{"projects":{},"projects":{}}'), root, () => {})).toThrow();
    expect(() => canonicalPnpmWorkspaceState(jsonBytes({ ...workspaceState(root), unknownTimestamp: 12 }), root, () => {}))
      .toThrow("unsupported");
    const noRoot = workspaceState(root);
    delete noRoot.projects[root];
    expect(() => canonicalPnpmWorkspaceState(jsonBytes(noRoot), root, () => {})).toThrow("root project");
    if (process.platform === "win32") {
      const alias = workspaceState(root);
      alias.projects[path.join(root, "NATIVE")] = { name: "alias", version: "1" };
      expect(() => canonicalPnpmWorkspaceState(jsonBytes(alias), root, () => {})).toThrow("collide");
    }
  });

  it("retains complete raw task runs and preserves invocation and latest-task identity", () => {
    expect(canonicalPnpmTaskState(taskState()).records).not.toEqual(canonicalPnpmTaskState(taskState(laterRun)).records);
    const changed = canonicalPnpmTaskState(taskState(laterRun, "b".repeat(64)));
    expect(changed.records).not.toEqual(canonicalPnpmTaskState(taskState()).records);
    const twoInvocations = [...taskState(), taskState(laterRun, "b".repeat(64))[1]!];
    const firstLatest = canonicalPnpmTaskState(twoInvocations);
    twoInvocations[0] = taskState(laterRun, "b".repeat(64))[0]!;
    expect(canonicalPnpmTaskState(twoInvocations).records).not.toEqual(firstLatest.records);
    for (const extra of ["start.lock/owner", `${invocation}.${firstRun}.jsonl`,
      `${invocation}.${firstRun}.published`, "unknown", `../${invocation}.${firstRun}.finished`]) {
      expect(() => canonicalPnpmTaskState([...taskState(), { path: extra, bytes: Buffer.alloc(0) }])).toThrow();
    }
    expect(() => canonicalPnpmTaskState(taskState().slice(0, 1))).toThrow();
    expect(() => canonicalPnpmTaskState([taskState()[0]!, taskState(laterRun)[1]!])).toThrow("finished marker");
    expect(() => canonicalPnpmTaskState([...taskState(), taskState(laterRun)[1]!])).toThrow("ambiguous");
    expect(() => canonicalPnpmTaskState([...taskState(), taskState()[1]!])).toThrow("duplicated");
    expect(() => canonicalPnpmTaskState(taskState("not-a-run"))).toThrow();
    expect(() => canonicalPnpmTaskState(taskState("000000000000-00000000-0000-4000-8000-000000000001"))).toThrow();
    const wrongVersion = taskState();
    wrongVersion[0]!.bytes = Buffer.from(JSON.stringify({ version: 2, invocation, run: firstRun }));
    expect(() => canonicalPnpmTaskState(wrongVersion)).toThrow("version");
    const unknownField = taskState();
    unknownField[0]!.bytes = Buffer.from(JSON.stringify({ version: 1, invocation, run: firstRun, finished: true }));
    expect(() => canonicalPnpmTaskState(unknownField)).toThrow("unsupported");
    const nonemptyMarker = taskState();
    nonemptyMarker[1]!.bytes = Buffer.from("not empty");
    expect(() => canonicalPnpmTaskState(nonemptyMarker)).toThrow("empty");
  });

  it("retains raw metadata hash, size, timestamps and task identities for before/after stability", () => {
    const original = dependencyFixture(path.resolve("candidate"), 1789516800000, firstRun).snapshot;
    for (const mutate of [
      (value: any) => { value.workspaceMetadata.sha256 = "b".repeat(64); },
      (value: any) => { value.workspaceMetadata.size++; },
      (value: any) => { value.workspaceMetadata.lastValidatedTimestamp++; },
      (value: any) => { value.workspaceMetadata.projectRoots[0] += "-other"; },
      (value: any) => { value.taskMetadata.latest.run = laterRun; },
      (value: any) => { value.taskMetadata.latest.invocation = "b".repeat(64); },
      (value: any) => { value.taskMetadata.files[0].sha256 = "b".repeat(64); },
      (value: any) => { value.taskMetadata.files[0].size++; },
      (value: any) => { value.executionIdentity.raw.scripts.native.build += " --changed"; },
    ]) {
      const changed = structuredClone(original);
      mutate(changed.builds.candidate.dependencySnapshot);
      expect(() => assertStableSnapshots(original, changed)).toThrow("mutated");
    }
  });

  it("statically binds all metadata bytes and physical project checks into live snapshots", () => {
    const evidence = readFileSync("benchmarks/method-audit-evidence.mjs", "utf8");
    expect(evidence).toContain("relative === PNPM_WORKSPACE_STATE || relative.startsWith(`${PNPM_TASK_STATE}/`)");
    expect(evidence).toContain('project => assertRealDirectory(project, "pnpm workspace project")');
    expect(evidence).toContain("taskRawReceipts.push({ path: relative, ...identity })");
    expect(evidence).toContain("canonicalPnpmTaskState(taskStateFiles)");
    expect(evidence).toContain("canonicalPnpmDependencyRecords(records, canonicalRecords, taskState,");
    expect(evidence).toContain("independentExecutionIdentity(checkout, canonicalRecords)");
    expect(evidence).toContain("execution: executionIdentity.canonical");
    expect(evidence).toContain("hash: digestJson(records)");
    expect(evidence).toContain("workspaceMetadata,");
  });
  it("canonicalizes only validated installation-specific pnpm metadata", () => {
    const candidate = path.resolve("candidate");
    const baseline = path.resolve("baseline");
    const left = canonicalPnpmModules(modulesMetadata(candidate), candidate);
    const right = canonicalPnpmModules(modulesMetadata(baseline, {
      prunedAt: "Wed, 16 Sep 2026 01:00:00 GMT",
    }), baseline);
    expect(left.sha256).toBe(right.sha256);
    expect(left.size).toBe(right.size);
    expect(left.prunedAt).not.toBe(right.prunedAt);
    expect(left.virtualStoreDir).not.toBe(right.virtualStoreDir);
    for (const change of [{ layoutVersion: 6 }, { hoistedDependencies: {} }, { storeDir: "/other/store" }]) {
      expect(canonicalPnpmModules(modulesMetadata(candidate, change), candidate).sha256).not.toBe(left.sha256);
    }
    expect(() => canonicalPnpmModules(modulesMetadata(candidate, { virtualStoreDir: "../../other" }), candidate))
      .toThrow("virtual store");
    expect(() => canonicalPnpmModules(modulesMetadata(candidate, { prunedAt: "invalid" }), candidate)).toThrow();
    expect(() => canonicalPnpmModules(Buffer.from("prunedAt: now\n"), candidate)).toThrow();
    expect(() => canonicalPnpmModules(Buffer.from('{"prunedAt":"a","prunedAt":"b"}'), candidate)).toThrow();
  });

  it("keeps raw installation metadata binding stable before and after measurement", () => {
    const snapshot = { planHash: "a", harness: {}, checkouts: {}, builds: {
      candidate: { dependencySnapshot: { hash: "raw-before", canonical: { hash: "same" },
        modulesMetadata: { prunedAt: "before", virtualStoreDir: "/candidate/node_modules/.pnpm" } } },
    } };
    const changed = structuredClone(snapshot);
    changed.builds.candidate.dependencySnapshot.modulesMetadata.prunedAt = "after";
    expect(() => assertStableSnapshots(snapshot, changed)).toThrow("mutated");
    const rawChanged = structuredClone(snapshot);
    rawChanged.builds.candidate.dependencySnapshot.hash = "raw-after";
    expect(() => assertStableSnapshots(snapshot, rawChanged)).toThrow("mutated");
  });

  it.each(["commit", "tree", "status", "blob", "sha256", "ino", "nlink", "mtimeNs", "ctimeNs"])(
    "rejects changed or unclean source lifecycle field %s", field => {
      const bindings = [sourceBinding(), sourceBinding(), sourceBinding()];
      expect(() => assertPathPrefixSourceLifecycle(bindings, expected)).not.toThrow();
      const binding = bindings[2]!;
      if (field === "commit" || field === "tree" || field === "status") binding[field] = "untracked-or-changed";
      else (binding.source as Record<string, string | number>)[field] = field === "nlink" ? "2" : "999";
      expect(() => assertPathPrefixSourceLifecycle(bindings, expected)).toThrow();
    },
  );

  it("requires all source phases and binds a descriptor read to the live pathname", () => {
    expect(() => assertPathPrefixSourceLifecycle([sourceBinding(), sourceBinding()], expected)).toThrow();
    const unknownIdentity = sourceBinding();
    unknownIdentity.source.ino = "0";
    expect(() => assertPathPrefixSourceLifecycle(Array(3).fill(unknownIdentity), expected)).toThrow("unavailable");
    const implementation = readFileSync("benchmarks/path-prefix-source-binding.mjs", "utf8");
    expect(implementation).toContain('"--untracked-files=all"');
    expect(implementation).toContain('fs.fstatSync(descriptor, { bigint: true })');
    expect(implementation).toContain('fs.lstatSync(file, { bigint: true })');
    expect(implementation).toContain('"dev", "ino", "size", "nlink", "mtimeNs", "ctimeNs"');
    expect(implementation).toContain('"live path-prefix source differs from the tracked blob"');
  });
});
