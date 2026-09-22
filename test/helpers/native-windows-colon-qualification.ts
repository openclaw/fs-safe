import { nativeWindowsColonDescriptors } from "../../benchmarks/native-windows-colon.mjs";

// Synthetic report data only; this helper never loads or calls fs-safe/native APIs.
const descriptors = nativeWindowsColonDescriptors();
const filter = "native-windows-colon/";
const privatePlacement = "prebuilt synthetic Windows pathname; no pathname filesystem lookup in selected error route";

export function nativeColonLoader(addonSha256 = "a".repeat(64)) {
  return {
    mechanism: "require-cache module.exports identity", loaderModule: "native.js",
    loaderSha256: "c".repeat(64), bindingMethod: "readOwnerAndDacl",
    addonRelativePath: "packages/win32-x64-msvc/fs-safe-native.node",
    addonBasename: "fs-safe-native.node", addonBytes: 4096, addonSha256,
    modulesAbi: "137", napiVersion: "10",
  };
}

export function nativeColonFacts() {
  return {
    status: "supported", isLocal: true, complete: true, daclPresent: true,
    unsupportedAceTypes: [], ownerSid: "S-1-5-21-1001", currentUserSid: "s-1-5-21-1002",
  };
}

export function nativeColonQualification(nativeLoader = nativeColonLoader()) {
  return {
    schemaVersion: 1, phase: "upfront before all selected row timing",
    timer: "not read by qualification driver", passes: 2, calls: 18,
    nativeLoader: { ...nativeLoader },
    outcomes: [1, 2].flatMap(pass => descriptors.map((row: { name: string; workloadDetails: { expectedReason?: string } }, index: number) => ({
      pass, name: row.name,
      outcome: index === 0 ? {
        kind: "public-success", status: "supported", isLocal: true, complete: true,
        daclPresent: true, unsupportedAceTypes: [], ownerSidValid: true, currentUserSidValid: true,
      } : { kind: "private-error", isError: true, code: "EINVAL", message: row.workloadDetails.expectedReason },
    }))),
  };
}

export function nativeColonReport(addonSha256 = "a".repeat(64)) {
  const nativeLoader = nativeColonLoader(addonSha256);
  return {
    metadata: {
      node: "v24.21.0", platform: "win32", arch: "x64", cpu: "Synthetic CPU", osRelease: "Synthetic Windows",
      workspaceFilesystem: { type: 1, blockSize: 4096 }, mode: "require", native: true,
      nativeLoader, nativeHash: addonSha256, nativeWindowsColonQualification: nativeColonQualification(nativeLoader),
    },
    results: descriptors.map((row: { name: string; workloadSemantics: string; workloadDetails: object }, index: number) => ({
      name: row.name, workloadSemantics: row.workloadSemantics, workloadDetails: row.workloadDetails,
      fixturePlacement: index > 0 ? privatePlacement : {
        kind: "existing runner input.json", bytes: 19, sha256: "d".repeat(64),
        canonicalParentDepth: 5, filesystemType: 1, filesystemBlockSize: 4096,
        inputUtf8Bytes: 23, inputUtf16CodeUnits: 23, inputSpelling: "ordinary-drive",
      },
      iterations: 20, samplesUs: [1, 2, 3, 4, 5], minUs: 1, medianUs: 3, maxUs: 5,
    })),
  };
}

function dependencies() {
  return {
    schemaVersion: 1, scope: "pnpm-layout-manifests-locks-native-v1", hash: "e".repeat(64),
    entries: 100, hashedBytes: 4096,
    limits: { maxEntries: 100_000, maxHashedBytes: 128 * 1024 * 1024 },
    limitation: "Synthetic dependency receipt; no installed dependency tree is inspected by this unit test.",
  };
}

export function nativeColonStudy(sameArtifact = false) {
  const specs = ["baseline", "candidate", "candidate", "baseline"].map((role, index) => ({
    file: `position-${index}.json`, role, buildId: sameArtifact ? "candidate-build" : `${role}-build`,
  }));
  const plan = {
    planHash: "f".repeat(64),
    settings: { filter, iterations: 20, samples: 5, controlKind: sameArtifact ? "same-artifact" : "source-comparison" },
    reports: specs,
    builds: sameArtifact ? [{ id: "candidate-build", sourceRole: "candidate" }]
      : [{ id: "baseline-build", sourceRole: "baseline" }, { id: "candidate-build", sourceRole: "candidate" }],
  };
  const reports = new Map(specs.map(spec => {
    const sourceRole = spec.buildId === "candidate-build" ? "candidate" : "baseline";
    const value = nativeColonReport(sourceRole === "candidate" ? "b".repeat(64) : "a".repeat(64));
    Object.assign(value.metadata, { measuredDistribution: { sourceRole, buildId: spec.buildId } });
    return [spec.file, value];
  }));
  const builds = Object.fromEntries(plan.builds.map(build => {
    const receipt = nativeColonLoader(build.sourceRole === "candidate" ? "b".repeat(64) : "a".repeat(64));
    return [build.id, {
      installationSchemaVersion: 1, runnerDistHash: "d".repeat(64),
      distTreeHash: { algorithm: "bounded-tree-sha256-v1", hash: "d".repeat(64), entries: 100, bytes: 4096 },
      dependencySnapshot: dependencies(),
      nativeArtifacts: [{ path: receipt.addonRelativePath, size: receipt.addonBytes, sha256: receipt.addonSha256 }],
    }];
  }));
  return { plan, reports, before: { planHash: plan.planHash, harness: { dependencySnapshot: dependencies() }, builds } };
}
