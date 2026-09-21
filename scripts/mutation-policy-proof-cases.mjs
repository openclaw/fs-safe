import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const EXTENDED_CASES = Object.freeze([
  ...["write", "create", "copy"].flatMap(operation => ["off", "require"].map(mode => ({
    name: `pinned-policy-${operation}-${mode}`, platform: "posix",
    backend: mode === "require" ? "pinned-native/require" : "pinned-js/off",
    observations: Object.freeze({
      operation, route: "pinned-parent-policy", eligibleControl: true,
      deeperParentDenied: true, admittedPrefixExists: true,
      redirectSeamCalls: 1, redirectedParentDenied: true,
      staleSeamCalls: 1, staleAuthorityCalls: 1, staleParentRejected: true,
      sentinelsPreserved: true, rejectedTargetsAbsent: true, rejectedStagesAbsent: true,
      testSeam: "built-post-preflight-hook",
    }),
  }))),
  ...["off", "require"].map(mode => ({
    name: `pinned-write-refusal-epochs-${mode}`, platform: "posix",
    backend: mode === "require" ? "pinned-native/require" : "pinned-js/off",
    observations: Object.freeze({
      route: "pinned-write-authority", epochs: 4, refusals: 4,
      callbacksAfterRefusal: 0, firstMkdirRefused: true, admittedPrefixObserved: true,
      stageRefused: true, completedPrivateStageObserved: true,
      destinationPreserved: true, ownedStageRemoved: true,
    }),
  })),
  ...["off", "require"].map(mode => ({
    name: `windows-buffer-write-${mode}`, platform: "win32",
    // The explicit compatibility option selects the JS writer even in require.
    backend: `windows-js/${mode}`,
    observations: Object.freeze({
      route: mode === "off" ? "windows-buffer-legacy" : "windows-buffer-compat",
      renamePolicy: mode === "off" ? "default" : "verify-content-with-lock",
      stableFinalSymlinkPublished: true, aliasPreserved: true,
      refusals: 3, callbacksAfterRefusal: 0, missingDestinationRefusals: 2,
      missingDestinationsAbsentAtCallbacks: true,
      missingDestinationsAbsentAfterRefusal: true, completedStagesObserved: 2,
      destinationPreserved: true, ownedStagesRemoved: true,
    }),
  })),
].map(entry => Object.freeze(entry)));

export function extendedCase(name) { return EXTENDED_CASES.find(entry => entry.name === name); }

const STAGE_NAME = /^\.fs-safe-[0-9a-f-]{36}\.tmp$/u;
const SENTINEL = "preserved sentinel";

function list(directory) { return fsSync.readdirSync(directory).sort(); }
function absent(file) {
  try { fsSync.lstatSync(file); return false; }
  catch (error) { if (error?.code === "ENOENT") return true; throw error; }
}
function assertEntries(directory, expected, invariant) {
  invariant(JSON.stringify(list(directory)) === JSON.stringify([...expected].sort()), "UNEXPECTED_FIXTURE_ENTRIES");
}
function assertSentinel(file, invariant) {
  invariant(fsSync.readFileSync(file, "utf8") === SENTINEL, "SENTINEL_CHANGED");
}
function completeStage(directory, payload, invariant) {
  const names = list(directory).filter(name => STAGE_NAME.test(name));
  invariant(names.length <= 1, "MULTIPLE_PRIVATE_STAGES");
  if (!names.length) return undefined;
  const file = path.join(directory, names[0]);
  const stat = fsSync.lstatSync(file, { bigint: true });
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, "UNSAFE_PRIVATE_STAGE");
  if (process.platform !== "win32") {
    invariant((stat.mode & 0o7777n) === 0o600n && stat.uid === BigInt(process.geteuid()), "NONPRIVATE_STAGE");
  }
  if (stat.size !== BigInt(payload.length)) return undefined;
  invariant(fsSync.readFileSync(file).equals(payload), "STAGE_CONTENT_INCOMPLETE");
  return file;
}

async function subroot(fixture, name, api, io) {
  const directory = path.join(fixture.directory, name);
  await io(fs.mkdir(directory, { mode: 0o700 }));
  await io(fs.writeFile(path.join(directory, "sentinel"), SENTINEL, { mode: 0o600 }));
  return { directory, safe: await io(api.root(directory)) };
}

async function operation(safe, kind, relative, source, payload, options, io) {
  if (kind === "write") await io(safe.write(relative, payload, options));
  else if (kind === "create") await io(safe.create(relative, payload, options));
  else await io(safe.copyIn(relative, source, { ...options, clone: "never" }));
}

async function pinnedPolicyCases(definition, api, fixture, helpers) {
  const { io, invariant, expectFailure, PAYLOAD } = helpers;
  const kind = definition.observations.operation;
  const source = path.join(fixture.directory, "copy-source");
  await io(fs.writeFile(source, PAYLOAD, { mode: 0o600 }));
  const hookUrl = import.meta.resolve("@openclaw/fs-safe/test-hooks");
  invariant(hookUrl.endsWith("/dist/test-hooks.js"), "TEST_SEAM_NOT_BUILT");
  const { __setFsSafeTestHooksForTest: setHooks } = await import("@openclaw/fs-safe/test-hooks");
  invariant(typeof setHooks === "function" && process.env.NODE_ENV === "test", "TEST_SEAM_UNAVAILABLE");

  const control = await subroot(fixture, "control", api, io);
  const controlTarget = path.join(control.directory, "one", "two", "value");
  await operation(control.safe, kind, path.join("one", "two", "value"), source, PAYLOAD, {
    durable: false, mode: 0o600, mutationSymlinks: "reject",
    denyMutations: { paths: [path.join(control.directory, "unrelated")] },
  }, io);
  invariant(fsSync.readFileSync(controlTarget).equals(PAYLOAD), "ELIGIBLE_CONTROL_FAILED");
  assertEntries(path.dirname(controlTarget), ["value"], invariant);
  assertSentinel(path.join(control.directory, "sentinel"), invariant);

  const denied = await subroot(fixture, "deeper-denied", api, io);
  const first = path.join(denied.directory, "one");
  await expectFailure(() => operation(denied.safe, kind, path.join("one", "two", "three", "value"),
    source, PAYLOAD, { durable: false, mode: 0o600, mutationSymlinks: "reject",
      denyMutations: { paths: [path.join(first, "two")] } }, io), "denied-path");
  invariant(fsSync.lstatSync(first).isDirectory(), "ADMITTED_PREFIX_NOT_CREATED");
  assertEntries(first, [], invariant);
  assertEntries(denied.directory, ["one", "sentinel"], invariant);
  assertSentinel(path.join(denied.directory, "sentinel"), invariant);

  for (const scenario of ["redirect", "stale"]) {
    const scope = await subroot(fixture, scenario, api, io);
    const allowed = path.join(scope.directory, "allowed");
    const saved = path.join(scope.directory, "saved");
    const protectedDir = path.join(scope.directory, "protected");
    for (const directory of [allowed, protectedDir]) {
      await io(fs.mkdir(directory, { mode: 0o700 }));
      await io(fs.writeFile(path.join(directory, "sentinel"), SENTINEL));
    }
    const selected = path.join(allowed, "nested", "value");
    let seamCalls = 0;
    let authorityCalls = 0;
    let swapped = false;
    setHooks({ beforePinnedWriteParentAdmission(target) {
      seamCalls += 1;
      invariant(seamCalls === 1 && target === selected, "PREFLIGHT_SEAM_NOT_EXACT");
      assertEntries(allowed, ["sentinel"], invariant);
      if (scenario === "redirect") {
        fsSync.renameSync(allowed, saved);
        fsSync.symlinkSync(path.basename(protectedDir), allowed, "dir");
        invariant(fsSync.lstatSync(allowed).isSymbolicLink() &&
          fsSync.readlinkSync(allowed) === path.basename(protectedDir) &&
          fsSync.realpathSync.native(allowed) === protectedDir, "REDIRECT_BINDING_NOT_INSTALLED");
        swapped = true;
      }
    } });
    try {
      await expectFailure(() => operation(scope.safe, kind, path.join("allowed", "nested", "value"),
        source, PAYLOAD, {
          durable: false, mode: 0o600,
          denyMutations: { prefixes: [protectedDir] },
          ...(scenario === "stale" ? { mutationSymlinks: "reject", assertBeforeMutation() {
            authorityCalls += 1;
            // With an existing allowed parent and missing nested child, this
            // public callback follows child-create policy admission in both
            // guarded-mkdir and native-pinned-write. No ordinal selects it.
            invariant(seamCalls === 1 && !swapped && authorityCalls === 1, "STALE_SEAM_NOT_REACHED");
            assertEntries(allowed, ["sentinel"], invariant);
            fsSync.renameSync(allowed, saved);
            fsSync.mkdirSync(allowed, { mode: 0o700 });
            fsSync.writeFileSync(path.join(allowed, "sentinel"), SENTINEL);
            swapped = true;
          } } : {}),
        }, io), scenario === "redirect" ? "denied-path" : "path-mismatch");
    } finally { setHooks(); }
    invariant(seamCalls === 1 && swapped && authorityCalls === (scenario === "stale" ? 1 : 0),
      "PARENT_FAULT_NOT_REACHED");
    if (scenario === "redirect") {
      invariant(fsSync.lstatSync(allowed).isSymbolicLink() &&
        fsSync.readlinkSync(allowed) === path.basename(protectedDir) &&
        fsSync.realpathSync.native(allowed) === protectedDir, "REDIRECT_BINDING_CHANGED");
    }
    for (const directory of [saved, protectedDir, ...(scenario === "stale" ? [allowed] : [])]) {
      assertEntries(directory, ["sentinel"], invariant);
      assertSentinel(path.join(directory, "sentinel"), invariant);
    }
    assertEntries(scope.directory, ["allowed", "protected", "saved", "sentinel"], invariant);
    assertSentinel(path.join(scope.directory, "sentinel"), invariant);
  }
  invariant(fsSync.readFileSync(source).equals(PAYLOAD), "COPY_SOURCE_CHANGED");
  return { ...definition.observations };
}

async function refusal(action, callbackState, invariant) {
  let caught;
  try { await action(); } catch (error) { caught = error; }
  invariant(caught === callbackState.reason && callbackState.refused && callbackState.after === 0,
    "AUTHORITY_REFUSAL_NOT_PRESERVED");
}
function authorityState(select, invariant) {
  const state = { reason: new Error("proof authority refusal"), refused: false, after: 0, calls: 0 };
  state.callback = () => {
    state.calls += 1;
    invariant(state.calls <= 32, "AUTHORITY_CALLBACK_LIMIT");
    if (state.refused) { state.after += 1; throw state.reason; }
    if (select()) { state.refused = true; throw state.reason; }
  };
  return state;
}

async function pinnedRefusalCases(definition, api, fixture, helpers) {
  const { io, invariant, PAYLOAD } = helpers;
  for (const epoch of ["first-mkdir", "after-mkdir", "stage", "publication"]) {
    const scope = await subroot(fixture, epoch, api, io);
    const walking = epoch.endsWith("mkdir");
    const first = path.join(scope.directory, "one");
    const parent = walking ? path.join(first, "two") : scope.directory;
    const target = path.join(parent, "value");
    if (!walking) await io(fs.writeFile(target, SENTINEL, { mode: 0o600 }));
    let observedStage;
    const state = authorityState(() => {
      assertSentinel(path.join(scope.directory, "sentinel"), invariant);
      if (walking) {
        invariant(absent(target) && absent(parent), "WALK_ADVANCED_PAST_REFUSAL");
        if (epoch === "first-mkdir") { invariant(absent(first), "FIRST_MKDIR_ALREADY_CREATED"); return true; }
        if (absent(first)) return false;
        assertEntries(first, [], invariant);
        return true;
      }
      assertSentinel(target, invariant);
      if (epoch === "stage") { assertEntries(parent, ["sentinel", "value"], invariant); return true; }
      observedStage = completeStage(parent, PAYLOAD, invariant);
      return observedStage !== undefined;
    }, invariant);
    await refusal(() => io(scope.safe.write(path.relative(scope.directory, target), PAYLOAD, {
      durable: false, mode: 0o600, mutationSymlinks: "reject",
      denyMutations: { paths: [path.join(scope.directory, "unrelated")] },
      assertBeforeMutation: state.callback,
    })), state, invariant);
    if (epoch === "first-mkdir") assertEntries(scope.directory, ["sentinel"], invariant);
    else if (epoch === "after-mkdir") {
      assertEntries(scope.directory, ["one", "sentinel"], invariant);
      assertEntries(first, [], invariant);
    } else {
      assertSentinel(target, invariant);
      assertEntries(parent, ["sentinel", "value"], invariant);
    }
    if (epoch === "publication") invariant(observedStage !== undefined && absent(observedStage), "OWNED_STAGE_NOT_REMOVED");
  }
  return { ...definition.observations };
}

async function windowsWriteCases(definition, api, fixture, helpers) {
  const { io, invariant, PAYLOAD } = helpers;
  const compatibility = definition.backend.endsWith("/require")
    ? { renameIdentity: "verify-content-with-lock" } : {};
  // The callback runs under the documented lock for the effective "selected"
  // target. Post-operation assertions below still require its removal.
  const activeLockEntries = compatibility.renameIdentity
    ? [`.fs-safe-write-${createHash("sha256").update("selected").digest("hex")}.lock`]
    : [];
  for (const scenario of ["stable", "stage-missing", "publish-missing", "publish-alias"]) {
    const scope = await subroot(fixture, scenario, api, io);
    const aliasCase = scenario === "stable" || scenario === "publish-alias";
    const target = path.join(scope.directory, "selected");
    const alias = path.join(scope.directory, "alias");
    if (aliasCase) {
      await io(fs.writeFile(target, SENTINEL, { mode: 0o600 }));
      await io(fs.symlink(target, alias, "file"));
    }
    const options = { durable: false, mode: 0o600, ...compatibility,
      denyMutations: { prefixes: [path.join(scope.directory, "unrelated")] } };
    if (scenario === "stable") {
      await io(scope.safe.write("alias", PAYLOAD, options));
      invariant(fsSync.readFileSync(target).equals(PAYLOAD), "WINDOWS_ALIAS_NOT_PUBLISHED");
    } else {
      let observedStage;
      const state = authorityState(() => {
        assertSentinel(path.join(scope.directory, "sentinel"), invariant);
        if (aliasCase) assertSentinel(target, invariant);
        else invariant(absent(target), "DESTINATION_VISIBLE_BEFORE_PUBLICATION");
        if (scenario === "stage-missing") {
          assertEntries(scope.directory, [...activeLockEntries, "sentinel"], invariant);
          return true;
        }
        observedStage = completeStage(scope.directory, PAYLOAD, invariant);
        return observedStage !== undefined;
      }, invariant);
      await refusal(() => io(scope.safe.write(aliasCase ? "alias" : "selected", PAYLOAD, {
        ...options, assertBeforeMutation: state.callback,
      })), state, invariant);
      invariant(aliasCase || absent(target), "MISSING_DESTINATION_CREATED");
      if (scenario !== "stage-missing") invariant(observedStage !== undefined && absent(observedStage), "OWNED_STAGE_NOT_REMOVED");
      if (aliasCase) assertSentinel(target, invariant);
    }
    if (aliasCase) {
      invariant(fsSync.lstatSync(alias).isSymbolicLink() && fsSync.realpathSync.native(alias) === target, "FINAL_ALIAS_CHANGED");
    }
    assertEntries(scope.directory, aliasCase ? ["alias", "selected", "sentinel"] : ["sentinel"], invariant);
    assertSentinel(path.join(scope.directory, "sentinel"), invariant);
  }
  return { ...definition.observations };
}

export async function executeExtendedCase(definition, api, fixture, helpers) {
  if (definition.name.startsWith("pinned-policy-")) return await pinnedPolicyCases(definition, api, fixture, helpers);
  if (definition.name.startsWith("pinned-write-refusal-")) return await pinnedRefusalCases(definition, api, fixture, helpers);
  return await windowsWriteCases(definition, api, fixture, helpers);
}
