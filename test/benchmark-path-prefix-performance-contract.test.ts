import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PATH_PREFIX_CAMPAIGN_ROWS } from "../benchmarks/path-prefix-campaign.mjs";
import { PNPM_METADATA_SOURCE, canonicalPathPrefixExecutionIdentity } from "../benchmarks/method-audit-dependency-identity.mjs";
import {
  PATH_PREFIX_COMPARISON_FAMILIES,
  PATH_PREFIX_GATE_SCOPES,
  PATH_PREFIX_JOB_SCHEMA,
  PATH_PREFIX_NATIVE_MODES,
  PATH_PREFIX_OUTER_JOBS,
  PATH_PREFIX_PERFORMANCE_VERSION,
  PATH_PREFIX_SAMPLES,
  analyzePathPrefixPerformanceCampaign,
  assertPathPrefixEvidenceInventory,
  assertPathPrefixManifestFileHash,
  assertPathPrefixWorkflowResults,
  bindPathPrefixResultReceipts,
  createPathPrefixPerformanceManifest,
  expectedPathPrefixReports,
  pathPrefixPerformanceGate,
  validatePathPrefixJobReceipt,
  validatePathPrefixPerformanceManifest,
} from "../benchmarks/path-prefix-performance-contract.mjs";

const hex = (character: string, count: number) => character.repeat(count);
const h256 = hex("a", 64);
const candidateCommit = hex("2", 40);
const candidateTree = hex("3", 40);
const baselineCommit = hex("4", 40);
const baselineTree = hex("5", 40);

function source(commit: string, tree: string, marker: string) {
  return {
    requestedRef: commit,
    commit,
    tree,
    manifestHash: marker.repeat(64),
    lockfileHash: marker.repeat(64),
    pathPrefixSourceBlob: marker.repeat(40),
    pathPrefixSourceHash: marker.repeat(64),
  };
}

function manifest() {
  return createPathPrefixPerformanceManifest({
    repository: "openclaw/fs-safe",
    runId: "12345",
    runAttempt: 1,
    workflowRef: "openclaw/fs-safe/.github/workflows/path-prefix-performance.yml@refs/heads/topic",
    harness: {
      requestedRef: hex("1", 40),
      commit: hex("1", 40),
      tree: hex("6", 40),
      manifestHash: hex("7", 64),
      lockfileHash: hex("8", 64),
      benchmarkHash: hex("9", 64),
      benchmarkFiles: [
        { path: "benchmarks/path-prefix-performance-evidence.mjs", blob: hex("a", 40), sha256: hex("a", 64) },
        { path: "package.json", blob: hex("b", 40), sha256: hex("b", 64) },
        { path: "pnpm-lock.yaml", blob: hex("c", 40), sha256: hex("c", 64) },
      ],
      workflowPath: ".github/workflows/path-prefix-performance.yml",
      workflowFileHash: hex("d", 64),
      methodWorkflowPath: ".github/workflows/benchmarks.yml",
      methodWorkflowFileHash: hex("e", 64),
    },
    candidate: source(candidateCommit, candidateTree, "e"),
    baseline: source(baselineCommit, baselineTree, "f"),
    analyzer: {
      version: PATH_PREFIX_PERFORMANCE_VERSION,
      path: "benchmarks/path-prefix-performance-evidence.mjs",
      blob: hex("a", 40),
      sha256: hex("a", 64),
    },
  });
}

function physical(pathname: string, seed: number) {
  return {
    schemaVersion: 1,
    path: pathname,
    realpath: pathname,
    identity: { dev: "1", ino: String(seed), nlink: "1" },
    entries: [
      { path: "index.js", type: "file", size: 10, dev: "1", ino: String(seed + 100), nlink: "1" },
    ],
  };
}

function distribution({ commit, tree, buildId, artifactPathId, seed, bytesHash }: {
  commit: string;
  tree: string;
  buildId: string;
  artifactPathId: string;
  seed: number;
  bytesHash: string;
}) {
  const checkout = `/workspace/${artifactPathId.split("/")[0]}`;
  const executionRaw = {
    schemaVersion: 1, packageManager: "pnpm@11.25.0",
    commands: [["pnpm", "--dir", checkout, "install", "--frozen-lockfile"],
      ["pnpm", "--dir", checkout, "build"], ["pnpm", "--dir", checkout, "native:build"]],
    taskPlan: { command: "run", params: ["build"], project: `${checkout}/native`, packageName: "@openclaw/fs-safe-native-build" },
    scripts: { root: { build: "node scripts/prepack-build.mjs", "native:build": "pnpm --filter @openclaw/fs-safe-native-build build" },
      native: { build: "napi build --platform --release && node ../scripts/stage-host-native.mjs" } },
    settings: { extraBinPaths: [`${checkout}/node_modules/.bin`], modulesDir: "node_modules", nodeOptions: "",
      workspaceStateHash: bytesHash, modulesStateHash: bytesHash },
    source: { commit, tree },
    files: ["package.json", "native/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
      .map(name => ({ path: `${checkout}/${name}`, sha256: bytesHash, size: 10 })),
  };
  const executionIdentity = { raw: executionRaw,
    canonical: canonicalPathPrefixExecutionIdentity(executionRaw, checkout, () => {}, path.posix) };
  return {
    sourceCommit: commit,
    sourceTree: tree,
    buildId,
    artifactPathId,
    distTreeHash: { algorithm: "bounded-tree-sha256-v1", hash: bytesHash, entries: 1, bytes: 10 },
    runnerDistHash: bytesHash,
    dependencySnapshot: {
      schemaVersion: 1,
      scope: "pnpm-layout-manifests-locks-native-v1",
      hash: bytesHash,
      canonical: { schemaVersion: 2, scope: "pnpm-install-and-build-identity-v2", hash: bytesHash, entries: 1,
        executionHash: executionIdentity.canonical.sha256 },
      executionIdentity,
      modulesMetadata: { path: ".modules.yaml", sha256: bytesHash, size: 10,
        prunedAt: "Wed, 16 Sep 2026 00:00:00 GMT",
        virtualStoreDir: `/workspace/${artifactPathId.split("/")[0]}/node_modules/.pnpm` },
      workspaceMetadata: { path: ".pnpm-workspace-state-v1.json", sha256: bytesHash, size: 10,
        lastValidatedTimestamp: 1789516800000, projectRoots: [`/workspace/${artifactPathId.split("/")[0]}`] },
      taskMetadata: { schemaVersion: 1, sourceCommit: PNPM_METADATA_SOURCE,
        latest: { version: 1, invocation: bytesHash, run: "01994abcd000-00000000-0000-4000-8000-000000000001" },
        completedInvocations: [bytesHash], files: [
          { path: ".pnpm-task-run-state-v1/latest.json", sha256: bytesHash, size: 151 },
          { path: `.pnpm-task-run-state-v1/${bytesHash}.01994abcd000-00000000-0000-4000-8000-000000000001.finished`,
            sha256: bytesHash, size: 0 },
        ] },
    },
    nativeArtifacts: [{ path: "packages/linux-x64-gnu/fs-safe-native.node", sha256: bytesHash, size: 10 }],
    physical: physical(`/workspace/${artifactPathId}`, seed),
  };
}

function rows(value: number) {
  return PATH_PREFIX_CAMPAIGN_ROWS.map(({ name, effectiveIterations }) => ({
    name,
    iterations: effectiveIterations,
    samplesUs: Array(PATH_PREFIX_SAMPLES).fill(value),
    executionReceiptHash: h256,
    fixtureReceiptHash: h256,
  }));
}

function family(name: string, order: string, values: { candidate?: number; baseline?: number } = {}) {
  const candidateValue = values.candidate ?? 100;
  const baselineValue = values.baseline ?? 100;
  const planMarker = name === "source-comparison" ? "a" : name === "same-source-rebuild" ? "b" : "c";
  const candidate = distribution({
    commit: candidateCommit,
    tree: candidateTree,
    buildId: "candidate-build",
    artifactPathId: "candidate/dist",
    seed: 10,
    bytesHash: hex("1", 64),
  });
  let baseline;
  if (name === "source-comparison") {
    baseline = distribution({
      commit: baselineCommit,
      tree: baselineTree,
      buildId: "baseline-build",
      artifactPathId: "baseline/dist",
      seed: 20,
      bytesHash: hex("2", 64),
    });
  } else if (name === "same-source-rebuild") {
    baseline = distribution({
      commit: candidateCommit,
      tree: candidateTree,
      buildId: "baseline-build",
      artifactPathId: "baseline/dist",
      seed: 20,
      bytesHash: hex("1", 64),
    });
  } else {
    baseline = structuredClone(candidate);
  }
  return {
    family: name,
    status: "complete",
    excluded: false,
    planHash: hex(planMarker, 64),
    planFileHash: h256,
    studyHash: h256,
    candidateDistribution: candidate,
    baselineDistribution: baseline,
    reports: expectedPathPrefixReports(order).map((report) => ({
      ...report,
      reportHash: h256,
      rows: rows(report.role === "candidate" ? candidateValue : baselineValue),
    })),
  };
}

function receipt(index: number, valuesByFamily: Record<string, { candidate?: number; baseline?: number }> = {}) {
  const job = PATH_PREFIX_OUTER_JOBS[index]!;
  return {
    schema: PATH_PREFIX_JOB_SCHEMA,
    version: PATH_PREFIX_PERFORMANCE_VERSION,
    status: "complete",
    excluded: false,
    campaignHash: manifest().campaignHash,
    manifestFileHash: h256,
    job: { ...job },
    workflow: { ...manifest().workflow },
    launchNonce: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    startedAt: "2026-09-16T00:00:00.000Z",
    finishedAt: "2026-09-16T01:00:00.000Z",
    runtime: {
      platform: job.runtimePlatform,
      arch: job.runnerArch.toLowerCase(),
      node: `v${job.nodeVersion}.10.0`,
      runnerOS: job.runnerOS,
      runnerArch: job.runnerArch,
      imageOS: `${job.platform}-image`,
      imageVersion: "20260916.1",
      runnerEnvironment: "github-hosted",
      githubJob: "path-prefix-study",
    },
    analyzer: { ...manifest().analyzer },
    inventory: [{ path: "job-start.json", sha256: h256, size: 10 }],
    families: PATH_PREFIX_COMPARISON_FAMILIES.map((name) =>
      family(name, job.order, valuesByFamily[name])),
  };
}

function completeReceipts() {
  return PATH_PREFIX_OUTER_JOBS.map((_job, index) => receipt(index));
}

describe("path-prefix performance campaign contract", () => {
  it("freezes and hashes exactly twelve serialized outer jobs", () => {
    const plan = manifest();
    expect(() => validatePathPrefixPerformanceManifest(plan)).not.toThrow();
    expect(plan.jobs).toEqual(PATH_PREFIX_OUTER_JOBS);
    expect(plan.jobs).toHaveLength(12);
    expect(new Set(plan.jobs.map(({ id }) => id)).size).toBe(12);
    expect(plan.jobs.filter(({ os }) => os === "macos-15").every(({ runnerArch }) =>
      runnerArch === "ARM64")).toBe(true);
    expect(plan.settings.serialization).toEqual({ maxParallelOuterJobs: 1, failFast: false });
    expect(plan.settings.comparisonFamilies).toEqual(PATH_PREFIX_COMPARISON_FAMILIES);
    expect(plan.settings.gates.exclusions).toBe(false);
    expect(plan.settings.gates.subtraction).toBe(false);
    expect(plan.settings.gates.selectiveReruns).toBe(false);
    const mutated = structuredClone(plan);
    mutated.jobs.pop();
    expect(() => validatePathPrefixPerformanceManifest(mutated)).toThrow();
  });

  it("requires all families, rows, modes, positions, blocks, and raw samples", () => {
    const result = analyzePathPrefixPerformanceCampaign(manifest(), completeReceipts());
    const expected = 12 * PATH_PREFIX_COMPARISON_FAMILIES.length *
      PATH_PREFIX_NATIVE_MODES.length * PATH_PREFIX_CAMPAIGN_ROWS.length * PATH_PREFIX_GATE_SCOPES.length;
    expect(result.overall).toBe("ACCEPT");
    expect(result.gates).toHaveLength(expected);
    expect(result.gates.find(gate => gate.scope === "block-1")!.sampleCountPerArm).toBe(18);
    expect(result.gates.find(gate => gate.scope === "pooled")!.sampleCountPerArm).toBe(54);
  });

  it("fails closed on missing, duplicate, excluded, or mismatched cells", () => {
    const missing = completeReceipts();
    missing.pop();
    expect(analyzePathPrefixPerformanceCampaign(manifest(), missing).overall).toBe("REJECT");

    const duplicate = completeReceipts();
    duplicate.push(structuredClone(duplicate[0]!));
    expect(analyzePathPrefixPerformanceCampaign(manifest(), duplicate).overall).toBe("REJECT");

    const excluded = receipt(0) as any;
    excluded.families[0].excluded = true;
    expect(() => validatePathPrefixJobReceipt(excluded, manifest())).toThrow("excluded");

    const wrongIterations = receipt(0) as any;
    wrongIterations.families[0].reports[0].rows[0].iterations = 2_000;
    expect(() => validatePathPrefixJobReceipt(wrongIterations, manifest()))
      .toThrow("effective iteration count mismatch");

    const wrongSource = receipt(0) as any;
    wrongSource.families[0].candidateDistribution.sourceTree = baselineTree;
    expect(() => validatePathPrefixJobReceipt(wrongSource, manifest())).toThrow("execution source tree mismatch");

    const missingRuntime = receipt(0) as any;
    missingRuntime.runtime.imageVersion = null;
    expect(() => validatePathPrefixJobReceipt(missingRuntime, manifest())).toThrow("must be a string");

    const wrongManifest = structuredClone(manifest());
    wrongManifest.campaignHash = hex("0", 64);
    expect(() => validatePathPrefixPerformanceManifest(wrongManifest)).toThrow("hash mismatch");
  });

  it("never lets controls cancel source failures and rejects any failing control", () => {
    const sourceFailure = completeReceipts();
    sourceFailure[0] = receipt(0, {
      "source-comparison": { candidate: 120, baseline: 100 },
      "same-source-rebuild": { candidate: 1, baseline: 100 },
      "same-artifact": { candidate: 1, baseline: 100 },
    });
    const sourceResult = analyzePathPrefixPerformanceCampaign(manifest(), sourceFailure);
    expect(sourceResult.overall).toBe("REJECT");
    expect(sourceResult.failures.some(failure => failure.type === "regression" &&
      failure.family === "source-comparison")).toBe(true);

    const controlFailure = completeReceipts();
    controlFailure[0] = receipt(0, {
      "same-source-rebuild": { candidate: 120, baseline: 100 },
    });
    const controlResult = analyzePathPrefixPerformanceCampaign(manifest(), controlFailure);
    expect(controlResult.overall).toBe("REJECT");
    expect(controlResult.failures.some(failure => failure.type === "regression" &&
      failure.family === "same-source-rebuild")).toBe(true);
  });

  it("uses strict OR gates and defines zero-baseline arithmetic", () => {
    expect(pathPrefixPerformanceGate([550], [500]).median.failed).toBe(false);
    expect(pathPrefixPerformanceGate([551], [500]).median.failed).toBe(true);
    expect(pathPrefixPerformanceGate([600], [500]).maximumSampleAverage.failed).toBe(false);
    expect(pathPrefixPerformanceGate([601], [500]).maximumSampleAverage.failed).toBe(true);
    expect(pathPrefixPerformanceGate([0], [0]).median).toMatchObject({
      relativeRegression: 0,
      failed: false,
    });
    expect(pathPrefixPerformanceGate([1], [0]).median).toMatchObject({
      relativeRegression: "+Infinity",
      failed: true,
    });
  });

  it("binds nested receipts and recomputed manifest/inventory hashes", () => {
    const first = bindPathPrefixResultReceipts({
      pathPrefixCampaignReceipt: { calls: 10, samples: [1, 2] },
      pathPrefixFixtureReceipt: { input: "/fixture/a" },
    });
    const changed = bindPathPrefixResultReceipts({
      pathPrefixCampaignReceipt: { calls: 9, samples: [1, 2] },
      pathPrefixFixtureReceipt: { input: "/fixture/a" },
    });
    expect(changed.executionReceiptHash).not.toBe(first.executionReceiptHash);
    expect(changed.fixtureReceiptHash).toBe(first.fixtureReceiptHash);
    expect(() => assertPathPrefixManifestFileHash({ manifestFileHash: h256 }, h256)).not.toThrow();
    expect(() => assertPathPrefixManifestFileHash({ manifestFileHash: h256 }, hex("b", 64))).toThrow();
    const inventory = [{ path: "report.json", sha256: h256, size: 10 }];
    expect(() => assertPathPrefixEvidenceInventory(inventory, structuredClone(inventory))).not.toThrow();
    const altered = structuredClone(inventory);
    altered[0]!.size = 11;
    expect(() => assertPathPrefixEvidenceInventory(inventory, altered)).toThrow();
  });

  it("proves rebuild distributions are byte-identical but physically independent", () => {
    const hardlinked = receipt(0) as any;
    hardlinked.families[1].baselineDistribution.physical.entries[0].dev =
      hardlinked.families[1].candidateDistribution.physical.entries[0].dev;
    hardlinked.families[1].baselineDistribution.physical.entries[0].ino =
      hardlinked.families[1].candidateDistribution.physical.entries[0].ino;
    expect(() => validatePathPrefixJobReceipt(hardlinked, manifest())).toThrow("hardlinked");

    const byteDrift = receipt(0) as any;
    byteDrift.families[1].baselineDistribution.runnerDistHash = hex("b", 64);
    expect(() => validatePathPrefixJobReceipt(byteDrift, manifest())).toThrow("runner dist bytes differ");

    const dependencyDrift = receipt(0) as any;
    dependencyDrift.families[1].baselineDistribution.dependencySnapshot.canonical.hash = hex("b", 64);
    expect(() => validatePathPrefixJobReceipt(dependencyDrift, manifest()))
      .toThrow("dependency layout differs");

    const installMetadataDrift = receipt(0) as any;
    installMetadataDrift.families[1].baselineDistribution.dependencySnapshot.hash = hex("b", 64);
    expect(() => validatePathPrefixJobReceipt(installMetadataDrift, manifest())).not.toThrow();

    const artifactDrift = receipt(0) as any;
    artifactDrift.families[2].baselineDistribution.physical.identity.ino = "999";
    expect(() => validatePathPrefixJobReceipt(artifactDrift, manifest())).toThrow("same-artifact");

    const roleDrift = receipt(0) as any;
    roleDrift.families[0].candidateDistribution.buildId = "baseline-build";
    expect(() => validatePathPrefixJobReceipt(roleDrift, manifest())).toThrow("role mapping");
  });

  it("wires the frozen serial workflow to filesystem revalidation and launch provenance", async () => {
    const [workflow, analyzer, methodEvidence] = await Promise.all([
      readFile(".github/workflows/path-prefix-performance.yml", "utf8"),
      readFile("benchmarks/path-prefix-performance-evidence.mjs", "utf8"),
      readFile("benchmarks/method-audit-evidence.mjs", "utf8"),
    ]);
    expect(workflow).toContain("max-parallel: 1");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("Measure source comparison");
    expect(workflow).toContain("Measure same-source-rebuild control");
    expect(workflow).toContain("Measure same-artifact control");
    expect(workflow).not.toMatch(/description: .*platform|description: .*order|description: .*node/iu);
    expect(analyzer).toContain("validateFamilyDirectory(jobRoot, family, manifest, start)");
    expect(analyzer).toContain("assertPathPrefixEvidenceInventory(receipt.inventory, actual)");
    expect(analyzer).toContain("live benchmark module inventory differs from the reviewed commit");
    expect(analyzer).toContain("reviewed harness benchmark file inventory differs from the frozen manifest");
    expect(analyzer).toContain("reconstructed raw runner output hash mismatch");
    expect(methodEvidence).toContain("distPhysicalSnapshot: physicalDistSnapshot(distRoot)");
    expect(methodEvidence).toContain("campaignLaunchNonce: process.env.METHOD_CAMPAIGN_LAUNCH_NONCE || null");
    // runner context is supported by steps, but not jobs.<job_id>.env.
    for (const environment of workflow.matchAll(/^    env:\r?\n((?:      .*\r?\n)+)/gmu)) {
      expect(environment[1]).not.toContain("runner.temp");
    }
    expect(workflow).toContain("PREPARE_RESULT: ${{ needs.prepare.result }}");
    expect(workflow).toContain("STUDY_RESULT: ${{ needs.path-prefix-study.result }}");
    expect(workflow).toContain('--prepare-result "$PREPARE_RESULT"');
    expect(workflow).toContain('--study-result "$STUDY_RESULT"');
    expect(workflow).not.toContain("continue-on-error:");
    expect(analyzer).toContain("assertPathPrefixWorkflowResults(workflowResults)");
    expect(analyzer).toContain("publicationRequiresSuccessfulAggregateJob: true");
    for (const bindingId of ["candidate", "source-baseline", "rebuild-baseline"]) {
      for (const phase of ["before-build", "after-build", "after-measurement"]) {
        expect(workflow).toContain(`--binding-id ${bindingId} --phase ${phase}`);
      }
    }
    expect(analyzer).toContain("assertPathPrefixSourceLifecycle(bindings, sourceForBinding(manifest, bindingId))");
    expect(analyzer).toContain("measured source differs from its build lifecycle");
    expect(methodEvidence).toContain("pathPrefixSourceBinding: collectPathPrefixSourceBinding(root)");
  });

  it.each(["failure", "cancelled", "skipped", "", undefined])(
    "rejects upstream result %s even when every measurement receipt accepts", result => {
      expect(analyzePathPrefixPerformanceCampaign(manifest(), completeReceipts()).overall).toBe("ACCEPT");
      expect(() => assertPathPrefixWorkflowResults({ prepare: result, study: "success" })).toThrow();
      expect(() => assertPathPrefixWorkflowResults({ prepare: "success", study: result })).toThrow();
      expect(() => assertPathPrefixWorkflowResults({ prepare: "success", study: "success" })).not.toThrow();
    },
  );
});
