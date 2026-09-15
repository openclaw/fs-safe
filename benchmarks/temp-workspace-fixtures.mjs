import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DEPTHS = Object.freeze([4, 8, 32]);
const LAYOUTS = Object.freeze(["existing-root", "missing-root"]);

export const TEMP_WORKSPACE_COVERAGE_NAMES = Object.freeze(
  ["", "Sync"].flatMap((suffix) => {
    const name = `tempWorkspace${suffix}`;
    return [
      name,
      `${name}/mode-correction`,
      ...(suffix ? [`${name}/forced-mode-correction`] : []),
      ...DEPTHS.flatMap((depth) =>
        LAYOUTS.map((layout) => `${name}/${layout}/depth=${depth}`)),
    ];
  }),
);

export function validateTempWorkspaceWorkloadResult(result) {
  const match = /^(tempWorkspace(?:Sync)?)\/(existing-root|missing-root)\/depth=(4|8|32)$/u
    .exec(result.name);
  if (!match) return;
  const requestedDepth = Number(match[3]);
  assert.equal(result.workloadDetails?.rootLayout, match[2],
    `temp-workspace root layout mismatch for ${result.name}`);
  assert.equal(result.workloadDetails?.requestedDepth, requestedDepth,
    `temp-workspace requested depth mismatch for ${result.name}`);
  assert(
    Number.isSafeInteger(result.workloadDetails?.canonicalComponentCount) &&
      result.workloadDetails.canonicalComponentCount > requestedDepth,
    `temp-workspace canonical component count mismatch for ${result.name}`,
  );
}

function canonicalComponentCount(directory) {
  const canonical = fs.realpathSync.native(directory);
  const relative = path.relative(path.parse(canonical).root, canonical);
  return relative.split(path.sep).filter(Boolean).length;
}

function assertOwner(stat) {
  if (typeof process.geteuid === "function") assert.equal(stat.uid, process.geteuid());
}

async function verifyAndCleanup(workspace, expectedMode, cleanupRoot) {
  const failures = [];
  let stat;
  let cleanupResult;
  if (!workspace) failures.push(new Error("temp workspace benchmark returned no workspace"));
  if (workspace) {
    try {
      stat = fs.lstatSync(workspace.dir);
    } catch (error) {
      failures.push(error);
    }
    try {
      cleanupResult = await workspace.cleanup();
    } catch (error) {
      failures.push(error);
    }
    if (fs.existsSync(workspace.dir)) failures.push(new Error("temp workspace cleanup left its directory"));
  }
  try {
    cleanupRoot?.();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "temp workspace benchmark cleanup failed");
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  if (process.platform !== "win32") assert.equal(stat.mode & 0o7777, expectedMode);
  assertOwner(stat);
  assert.equal(cleanupResult, "removed");
}

function modeCorrectionOptions(sync, directRequestedModePlatform, ordinaryProbe) {
  return {
    sync,
    skip: process.platform === "win32" ? "Windows does not initialize POSIX directory modes." : undefined,
    before: sync && directRequestedModePlatform
      ? () => {
          fs.rmSync(ordinaryProbe, { recursive: true, force: true });
          fs.mkdirSync(ordinaryProbe, { mode: 0o750 });
          try {
            const initial = fs.lstatSync(ordinaryProbe);
            assert.equal(initial.isDirectory(), true);
            assert.equal(initial.isSymbolicLink(), false);
            assert.equal(initial.mode & 0o7777, 0o750,
              "ordinary requested-mode preflight did not produce initial mode 0750");
            assertOwner(initial);
          } finally {
            fs.rmSync(ordinaryProbe, { recursive: true, force: true });
          }
        }
      : undefined,
    after: (workspace) => verifyAndCleanup(workspace, 0o750),
  };
}

function registerForcedModeCorrection({ api, name, tempOptions, workspace, register }) {
  let previousUmask;
  const probe = path.join(workspace, ".fs-safe-temp-mode-correction-probe");
  const reset = () => {
    const failures = [];
    try {
      fs.rmSync(probe, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    const restore = previousUmask;
    previousUmask = undefined;
    if (restore !== undefined) {
      try {
        process.umask(restore);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "forced mode-correction benchmark reset failed");
  };
  register(`${name}/forced-mode-correction`, () => api[name]({ ...tempOptions, dirMode: 0o750 }), {
    sync: true,
    skip: ["linux", "darwin"].includes(process.platform)
      ? undefined
      : "The requested-mode direct creation path requires Linux or macOS.",
    before: () => {
      try {
        assert.equal(previousUmask, undefined, "forced mode-correction benchmark setup leaked");
        previousUmask = process.umask(0o077);
        fs.mkdirSync(probe, { mode: 0o750 });
        const initial = fs.lstatSync(probe);
        assert.equal(initial.isDirectory(), true);
        assert.equal(initial.isSymbolicLink(), false);
        assert.equal(initial.mode & 0o7777, 0o700,
          "forced mode-correction preflight did not produce initial mode 0700");
        assertOwner(initial);
        fs.rmdirSync(probe);
      } catch (error) {
        try {
          reset();
        } catch (resetError) {
          throw new AggregateError(
            [error, resetError],
            "forced mode-correction benchmark preflight and reset failed",
          );
        }
        throw error;
      }
    },
    after: async (created) => {
      const failures = [];
      try {
        await verifyAndCleanup(created, 0o750);
      } catch (error) {
        failures.push(error);
      }
      try {
        reset();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "forced mode-correction benchmark cleanup failed");
      }
    },
  });
}

function registerDepthRows({ api, name, sync, tempOptions, workspace, register }) {
  for (const depth of DEPTHS) {
    for (const layout of LAYOUTS) {
      const fixture = path.join(workspace, `temp-root-${name}-${layout}-${depth}`);
      const rootDir = path.join(fixture, ...Array.from({ length: depth }, (_, index) => `d${index + 1}`));
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") fs.chmodSync(rootDir, 0o700);
      const componentCount = canonicalComponentCount(rootDir);
      if (layout === "missing-root") fs.rmSync(fixture, { recursive: true, force: true });
      register(`${name}/${layout}/depth=${depth}`, () => api[name]({ ...tempOptions, rootDir }), {
        sync,
        workloadDetails: {
          rootLayout: layout,
          requestedDepth: depth,
          canonicalComponentCount: componentCount,
        },
        before: () => {
          if (layout === "missing-root") {
            fs.rmSync(fixture, { recursive: true, force: true });
          } else {
            fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
            if (process.platform !== "win32") fs.chmodSync(rootDir, 0o700);
          }
        },
        after: (created) => verifyAndCleanup(
          created,
          0o700,
          layout === "missing-root"
            ? () => {
                fs.rmSync(fixture, { recursive: true, force: true });
                assert.equal(fs.existsSync(fixture), false, "missing temp root cleanup failed");
              }
            : undefined,
        ),
      });
    }
  }
}

export function registerTempWorkspaceCoverage({ api, workspace, register, tempOptions, suffix }) {
  const name = `tempWorkspace${suffix}`;
  const sync = suffix === "Sync";
  const ordinaryProbe = path.join(workspace, ".fs-safe-temp-mode-ordinary-probe");
  register(name, () => api[name](tempOptions), {
    sync,
    after: (created) => verifyAndCleanup(created, 0o700),
  });
  register(`${name}/mode-correction`, () => api[name]({ ...tempOptions, dirMode: 0o750 }),
    modeCorrectionOptions(sync, ["linux", "darwin"].includes(process.platform), ordinaryProbe));
  if (sync) registerForcedModeCorrection({ api, name, tempOptions, workspace, register });
  registerDepthRows({ api, name, sync, tempOptions, workspace, register });
}
