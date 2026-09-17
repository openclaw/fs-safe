import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function separatorFor(platform) {
  return platform === "win32" ? "\\" : "/";
}

function normalizeSeparators(value, platform) {
  return platform === "win32" ? value.replaceAll("/", "\\") : value;
}

export function pathPrefixRawRoot(absolutePath, platform = process.platform) {
  const normalized = normalizeSeparators(absolutePath, platform);
  if (platform === "win32" && /^\\\\[?.]\\UNC\\/iu.test(normalized)) {
    const shareRoot = path.win32.parse(`\\\\${normalized.slice(8)}`).root;
    return normalized.slice(0, shareRoot.length + 6);
  }
  return pathApi(platform).parse(normalized).root;
}

export function pathPrefixRawComponentCount(absolutePath, platform = process.platform) {
  const normalized = normalizeSeparators(absolutePath, platform);
  const root = pathPrefixRawRoot(normalized, platform);
  assert(root, `path-prefix fixture path is not absolute: ${absolutePath}`);
  return normalized.slice(root.length).split(separatorFor(platform)).length;
}

export function pathPrefixRootDescription(absolutePath, platform = process.platform) {
  const spelling = pathPrefixRawRoot(absolutePath, platform);
  assert(spelling, `path-prefix fixture path is not absolute: ${absolutePath}`);
  let kind;
  if (platform !== "win32") kind = "posix";
  else if (/^\\\\[?.]\\UNC\\/iu.test(spelling)) kind = "extended-unc";
  else if (/^\\\\[?.]\\/u.test(spelling)) kind = "namespace-drive";
  else if (spelling.startsWith("\\\\")) kind = "unc";
  else kind = "drive";
  return { kind, spelling };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function identity(pathname) {
  const stat = fs.lstatSync(pathname, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function samePath(left, right, platform) {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validateIdentity(label, value) {
  assert(value && typeof value === "object", `${label} identity is missing`);
  assert.match(value.dev, /^[0-9]+$/u, `${label} device identity is invalid`);
  assert.match(value.ino, /^[0-9]+$/u, `${label} inode identity is invalid`);
}

function targetQueueObservation(observedTarget, platform) {
  const normalized = normalizeSeparators(observedTarget, platform);
  const api = pathApi(platform);
  const root = api.isAbsolute(normalized) ? pathPrefixRawRoot(normalized, platform) : "";
  return {
    count: normalized.slice(root.length).split(separatorFor(platform)).length,
    root: root ? pathPrefixRootDescription(normalized, platform) : { kind: "relative", spelling: "" },
  };
}

function captureFixtureReceipt(spec) {
  const workspaceCanonicalPath = fs.realpathSync.native(spec.workspace);
  assert(samePath(workspaceCanonicalPath, spec.workspace, spec.platform),
    `${spec.name} workspace spelling changed`);
  assert(fs.lstatSync(spec.workspace).isDirectory(), `${spec.name} workspace is not a directory`);
  const existingPath = fs.realpathSync.native(spec.existingPath);
  const queue = {
    initial: pathPrefixRawComponentCount(spec.input, spec.platform),
    target: null,
    pending: null,
    expanded: null,
  };
  let link = {
    kind: "none",
    path: null,
    identity: null,
    observedTarget: null,
    targetRoot: null,
  };
  if (spec.linkPath) {
    const linkStat = fs.lstatSync(spec.linkPath);
    assert(linkStat.isSymbolicLink(), `${spec.name} fixture link was replaced`);
    const observedTarget = normalizeSeparators(fs.readlinkSync(spec.linkPath), spec.platform);
    const target = targetQueueObservation(observedTarget, spec.platform);
    queue.target = target.count;
    queue.pending = spec.pendingSegments.length;
    queue.expanded = target.count + spec.pendingSegments.length;
    link = {
      kind: spec.linkKind,
      path: spec.linkPath,
      identity: identity(spec.linkPath),
      observedTarget,
      targetRoot: target.root,
    };
  }
  return deepFreeze({
    schemaVersion: 1,
    row: spec.name,
    platform: spec.platform,
    input: spec.input,
    inputRoot: pathPrefixRootDescription(spec.input, spec.platform),
    workspace: {
      path: spec.workspace,
      canonicalPath: workspaceCanonicalPath,
      depth: pathPrefixRawComponentCount(spec.workspace, spec.platform),
      root: pathPrefixRootDescription(spec.workspace, spec.platform),
      identity: identity(spec.workspace),
    },
    expected: {
      existingPath,
      existingIdentity: identity(existingPath),
      unresolvedSegments: [...spec.unresolvedSegments],
    },
    queue,
    link,
  });
}

function populatedPathAtComponentCount(base, componentCount, platform) {
  const baseCount = pathPrefixRawComponentCount(base, platform);
  assert(baseCount < componentCount,
    `benchmark workspace already has ${baseCount} components; cannot create depth ${componentCount}`);
  const suffix = Array.from(
    { length: componentCount - baseCount },
    (_, index) => `p${String(baseCount + index + 1).padStart(2, "0")}`,
  );
  const populated = path.join(base, ...suffix);
  fs.mkdirSync(populated, { recursive: true });
  assert.equal(pathPrefixRawComponentCount(populated, platform), componentCount);
  return populated;
}

function sourceAtComponentCount(base, aliasName, missingName, componentCount, platform) {
  const separator = separatorFor(platform);
  const ordinary = `${base}${separator}${aliasName}${separator}${missingName}`;
  const extra = componentCount - pathPrefixRawComponentCount(ordinary, platform);
  assert(extra >= 0, `benchmark workspace is too deep for a ${componentCount}-component source`);
  const input = `${base}${separator.repeat(extra + 1)}${aliasName}${separator}${missingName}`;
  assert.equal(pathPrefixRawComponentCount(input, platform), componentCount);
  return input;
}

function fixture(spec) {
  const frozenSpec = deepFreeze(spec);
  const receipt = captureFixtureReceipt(frozenSpec);
  return Object.freeze({
    input: frozenSpec.input,
    receipt,
    inspect: () => captureFixtureReceipt(frozenSpec),
    expected: receipt.expected,
  });
}

export function createPathPrefixFixtureCohort({ workspace, definitions, queueLimit }) {
  const platform = process.platform;
  const parent = fs.realpathSync.native(workspace);
  assert(samePath(parent, workspace, platform), "path-prefix campaign parent must use canonical spelling");
  const campaignWorkspace = path.join(parent, "path-prefix-campaign");
  const prospectiveDepth = pathPrefixRawComponentCount(campaignWorkspace, platform);
  assert(prospectiveDepth + 2 <= queueLimit,
    `path-prefix campaign workspace depth ${prospectiveDepth} cannot exercise the ${queueLimit}-component boundary`);
  fs.mkdirSync(campaignWorkspace);
  const canonicalWorkspace = fs.realpathSync.native(campaignWorkspace);
  assert(samePath(canonicalWorkspace, campaignWorkspace, platform),
    "path-prefix campaign workspace must use canonical spelling");
  const workspaceDepth = pathPrefixRawComponentCount(canonicalWorkspace, platform);
  assert(workspaceDepth + 2 <= queueLimit,
    `path-prefix campaign workspace depth ${workspaceDepth} cannot exercise the ${queueLimit}-component boundary`);

  const byName = new Map();
  const add = (name, input, existingPath, unresolvedSegments = [], options = {}) => {
    const created = fixture({
      name,
      platform,
      workspace: canonicalWorkspace,
      input,
      existingPath,
      unresolvedSegments,
      linkPath: options.linkPath ?? null,
      linkKind: options.linkKind ?? "none",
      pendingSegments: options.pendingSegments ?? [],
    });
    byName.set(name, created);
  };

  const existing = path.join(canonicalWorkspace, "input.json");
  fs.writeFileSync(existing, "path-prefix campaign fixture\n", { flag: "wx" });
  add("resolvePathPrefixSync/existing", existing, existing);
  const missingInput = `${canonicalWorkspace}${path.sep}future${path.sep}..${path.sep}input.json`;
  add("resolvePathPrefixSync/missing", missingInput, canonicalWorkspace, ["future", "..", "input.json"]);

  const filesystemRoot = pathPrefixRawRoot(canonicalWorkspace, platform);
  const rootMissing = `.fs-safe-prefix-benchmark-${path.basename(parent)}`;
  assert.equal(fs.existsSync(path.join(filesystemRoot, rootMissing)), false,
    "path-prefix queue benchmark marker unexpectedly exists");
  for (const queueLength of [queueLimit, queueLimit + 1]) {
    const queueInput = `${filesystemRoot}${path.sep.repeat(queueLength - 1)}${rootMissing}`;
    assert.equal(pathPrefixRawComponentCount(queueInput, platform), queueLength);
    add(`resolvePathPrefixSync/queue-boundary-${queueLength}`, queueInput, filesystemRoot, [rootMissing]);
  }

  const separatorHeavy = `${canonicalWorkspace}${path.sep.repeat(4096)}future`;
  add("resolvePathPrefixSync/separator-heavy", separatorHeavy, canonicalWorkspace, ["future"]);

  const populated32 = populatedPathAtComponentCount(canonicalWorkspace, queueLimit, platform);
  const populated33 = populatedPathAtComponentCount(populated32, queueLimit + 1, platform);
  add("resolvePathPrefixSync/populated-existing-depth-32", populated32, populated32);
  add("resolvePathPrefixSync/populated-existing-depth-33", populated33, populated33);

  const smallTarget = path.join(canonicalWorkspace, "prefix-small-target");
  fs.mkdirSync(smallTarget);
  const missingName = "missing-after-link";
  const linkKind = platform === "win32" ? "junction" : "dir";
  for (const sourceClass of ["small", "large"]) {
    for (const targetClass of ["small", "large"]) {
      const transition = `${sourceClass}-to-${targetClass}`;
      const aliasName = `prefix-${transition}`;
      const alias = path.join(canonicalWorkspace, aliasName);
      const target = targetClass === "small" ? smallTarget : populated32;
      fs.symlinkSync(target, alias, linkKind);
      const input = sourceClass === "small"
        ? `${alias}${path.sep}${missingName}`
        : sourceAtComponentCount(canonicalWorkspace, aliasName, missingName, queueLimit + 1, platform);
      add(`resolvePathPrefixSync/symlink-${transition}`, input, target, [missingName], {
        linkPath: alias,
        linkKind,
        pendingSegments: [missingName],
      });
    }
  }

  assert.deepEqual([...byName.keys()], definitions.map(({ name }) => name),
    "path-prefix fixture row set mismatch");
  return Object.freeze({
    workspace: canonicalWorkspace,
    workspaceDepth,
    fixtures: byName,
    receipts: Object.freeze(definitions.map(({ name }) => byName.get(name).receipt)),
  });
}

export function validatePathPrefixFixtureReceipt(receipt, definition, platform, queueLimit) {
  assert(receipt && typeof receipt === "object", `${definition.name} fixture receipt is missing`);
  assert(["linux", "darwin", "win32"].includes(platform),
    `${definition.name} fixture platform is unsupported`);
  assert.equal(receipt.schemaVersion, 1, `${definition.name} fixture receipt schema mismatch`);
  assert.equal(receipt.row, definition.name, `${definition.name} fixture receipt row mismatch`);
  assert.equal(receipt.platform, platform, `${definition.name} fixture platform mismatch`);
  assert.equal(typeof receipt.input, "string", `${definition.name} fixture input is invalid`);
  assert.deepEqual(receipt.inputRoot, pathPrefixRootDescription(receipt.input, platform),
    `${definition.name} effective input root mismatch`);
  assert.deepEqual(receipt.workspace.root,
    pathPrefixRootDescription(receipt.workspace.canonicalPath, platform),
    `${definition.name} effective workspace root mismatch`);
  assert.equal(receipt.workspace.depth,
    pathPrefixRawComponentCount(receipt.workspace.canonicalPath, platform),
    `${definition.name} workspace depth mismatch`);
  assert(samePath(receipt.workspace.path, receipt.workspace.canonicalPath, platform),
    `${definition.name} workspace spelling mismatch`);
  assert(receipt.workspace.depth + 2 <= queueLimit,
    `${definition.name} workspace is too deep for the queue boundary`);
  validateIdentity(`${definition.name} workspace`, receipt.workspace.identity);
  validateIdentity(`${definition.name} existing prefix`, receipt.expected.existingIdentity);
  assert.equal(receipt.queue.initial, pathPrefixRawComponentCount(receipt.input, platform),
    `${definition.name} initial queue count mismatch`);
  assert(Array.isArray(receipt.expected.unresolvedSegments),
    `${definition.name} unresolved suffix receipt is invalid`);

  const boundary = definition.name.match(/(?:queue-boundary|populated-existing-depth)-(32|33)$/u);
  if (boundary) {
    assert.equal(receipt.queue.initial, Number(boundary[1]),
      `${definition.name} did not preserve its exact queue boundary`);
  }
  const transition = definition.queueTransition?.split("-to-");
  if (transition) {
    const [sourceClass, targetClass] = transition;
    assert(receipt.link && receipt.link.kind === (platform === "win32" ? "junction" : "dir"),
      `${definition.name} directory-link kind mismatch`);
    assert.equal(typeof receipt.link.observedTarget, "string",
      `${definition.name} observed link target is missing`);
    assert(pathApi(platform).isAbsolute(receipt.link.observedTarget),
      `${definition.name} observed link target is not absolute`);
    validateIdentity(`${definition.name} directory link`, receipt.link.identity);
    const target = targetQueueObservation(receipt.link.observedTarget, platform);
    assert.equal(receipt.queue.target, target.count, `${definition.name} target queue count mismatch`);
    assert.deepEqual(receipt.link.targetRoot, target.root, `${definition.name} target root mismatch`);
    assert.equal(receipt.queue.pending, receipt.expected.unresolvedSegments.length,
      `${definition.name} pending queue count mismatch`);
    assert.deepEqual(receipt.expected.unresolvedSegments, ["missing-after-link"],
      `${definition.name} pending queue suffix mismatch`);
    assert.equal(receipt.queue.expanded, receipt.queue.target + receipt.queue.pending,
      `${definition.name} expanded queue count mismatch`);
    assert.equal(receipt.queue.initial <= queueLimit, sourceClass === "small",
      `${definition.name} source queue transition mismatch`);
    assert.equal(receipt.queue.expanded <= queueLimit, targetClass === "small",
      `${definition.name} expanded queue transition mismatch`);
    if (sourceClass === "large") {
      assert.equal(receipt.queue.initial, queueLimit + 1,
        `${definition.name} large source queue is not the adjacent boundary`);
    }
    if (targetClass === "large") {
      assert.equal(receipt.queue.expanded, queueLimit + 1,
        `${definition.name} large expanded queue is not the adjacent boundary`);
    }
  } else {
    assert.deepEqual(receipt.link, {
      kind: "none", path: null, identity: null, observedTarget: null, targetRoot: null,
    }, `${definition.name} unexpected link receipt`);
    assert.deepEqual(receipt.queue, {
      initial: receipt.queue.initial, target: null, pending: null, expanded: null,
    }, `${definition.name} unexpected expanded queue receipt`);
  }
  return receipt;
}
