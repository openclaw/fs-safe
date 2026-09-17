import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHarnessBytesMatchManifest,
  createImmutableHarnessManifest,
  SYNC_LOCK_ROOT_CAPTURE_PATH,
  SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS,
} from "../benchmarks/sync-lock-root-harness-integrity.mjs";

const roots: string[] = [];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-harness-integrity-"));
  roots.push(root);
  const files = [...SYNC_LOCK_ROOT_REQUIRED_HARNESS_PATHS].sort().map((relative, index) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(`reviewed-${index}\n`);
    fs.writeFileSync(file, bytes);
    return { path: relative, blob: String(index + 1).padStart(40, "0"),
      sha256: sha256(bytes), size: bytes.length };
  });
  const expectedCapture = files.find(({ path: relative }) => relative === SYNC_LOCK_ROOT_CAPTURE_PATH)!;
  const launcher = path.join(root, "private-launcher.sh");
  fs.copyFileSync(path.join(root, ...SYNC_LOCK_ROOT_CAPTURE_PATH.split("/")), launcher);
  const manifest = {
    schema: "fs-safe-sync-lock-root-harness-integrity-v1",
    harnessSha: "a".repeat(40),
    files,
    executedCapture: {
      sourcePath: SYNC_LOCK_ROOT_CAPTURE_PATH,
      sha256: expectedCapture.sha256,
      size: expectedCapture.size,
    },
  };
  return { launcher, manifest, root };
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function gitInput(root: string, input: Buffer, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();
}

function gitAllowReplacements(root: string, environment: NodeJS.ProcessEnv, ...args: string[]) {
  const env = { ...process.env, ...environment };
  delete env.GIT_NO_REPLACE_OBJECTS;
  return execFileSync("git", ["-C", root, ...args], { env });
}

function withGitEnvironment<T>(environment: NodeJS.ProcessEnv, callback: () => T): T {
  const previous: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, environment);
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function committedFixture() {
  const value = fixture();
  git(value.root, "init", "-q");
  git(value.root, "config", "core.autocrlf", "false");
  git(value.root, "config", "core.eol", "lf");
  git(value.root, "config", "user.email", "proof@example.invalid");
  git(value.root, "config", "user.name", "Proof Fixture");
  git(value.root, "config", "commit.gpgsign", "false");
  git(value.root, "config", "core.useReplaceRefs", "true");
  git(value.root, "add", "--all");
  git(value.root, "commit", "-q", "-m", "fixture");
  const harnessSha = git(value.root, "rev-parse", "HEAD");
  fs.copyFileSync(path.join(value.root, ...SYNC_LOCK_ROOT_CAPTURE_PATH.split("/")), value.launcher);
  return { ...value, harnessSha };
}

type ReplacementKind = "commit" | "tree" | "blob" | "namespaced" | "alternate-base" |
  "configured";

function replacementFixture(kind: ReplacementKind, targetPath =
  "benchmarks/sync-lock-root-analysis.mjs") {
  const value = committedFixture();
  const workflowPath = ".github/workflows/sync-lock-root-performance-proof.yml";
  const target = path.join(value.root, ...targetPath.split("/"));
  const workflow = path.join(value.root, ...workflowPath.split("/"));
  const originalBytes = fs.readFileSync(target);
  const originalWorkflowBytes = fs.readFileSync(workflow);
  const originalBlob = git(value.root, "--no-replace-objects", "rev-parse",
    `${value.harnessSha}:${targetPath}`);
  const originalWorkflowBlob = git(value.root, "--no-replace-objects", "rev-parse",
    `${value.harnessSha}:${workflowPath}`);
  const substituted = Buffer.from("attacker-controlled replacement bytes\n");
  const substitutedWorkflow = Buffer.from("attacker-controlled workflow replacement\n");
  const replacementBlob = gitInput(value.root, substituted, "hash-object", "-w", "--stdin");
  let originalObject = originalBlob;
  let replacementObject = replacementBlob;
  if (kind === "commit" || kind === "tree") {
    fs.writeFileSync(target, substituted);
    fs.writeFileSync(workflow, substitutedWorkflow);
    git(value.root, "add", "--", targetPath, workflowPath);
    git(value.root, "commit", "-q", "-m", "replacement");
    const replacementCommit = git(value.root, "rev-parse", "HEAD");
    if (kind === "commit") {
      originalObject = value.harnessSha;
      replacementObject = replacementCommit;
    } else {
      originalObject = git(value.root, "--no-replace-objects", "rev-parse",
        `${value.harnessSha}^{tree}`);
      replacementObject = git(value.root, "--no-replace-objects", "rev-parse",
        `${replacementCommit}^{tree}`);
    }
    git(value.root, "checkout", "-q", "--detach", value.harnessSha);
    expect(fs.readFileSync(target)).toEqual(originalBytes);
  }
  let environment: NodeJS.ProcessEnv = {};
  if (kind === "namespaced") {
    const replacementBase = "refs/namespaces/proof/refs/replace";
    git(value.root, "update-ref", `${replacementBase}/${originalObject}`, replacementObject);
    environment = { GIT_REPLACE_REF_BASE: `${replacementBase}/` };
  } else if (kind === "alternate-base") {
    git(value.root, "update-ref", `refs/proof-replacements/${originalObject}`, replacementObject);
    environment = { GIT_REPLACE_REF_BASE: "refs/proof-replacements/" };
  } else {
    gitAllowReplacements(value.root, {}, "replace", originalObject, replacementObject);
    if (kind === "configured") {
      environment = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.useReplaceRefs",
        GIT_CONFIG_VALUE_0: "true",
      };
    }
  }
  expect(gitAllowReplacements(value.root, environment, "cat-file", "blob",
    `${value.harnessSha}:${targetPath}`)).toEqual(substituted);
  if (kind === "commit" || kind === "tree") {
    expect(gitAllowReplacements(value.root, environment, "cat-file", "blob",
      `${value.harnessSha}:${workflowPath}`)).toEqual(substitutedWorkflow);
  }
  return { ...value, environment, originalBlob, originalBytes, originalWorkflowBlob,
    originalWorkflowBytes, targetPath, workflowPath };
}

function hiddenGitMutation(kind: "assume-unchanged" | "skip-worktree" | "filter-hidden") {
  const value = committedFixture();
  let harnessSha = value.harnessSha;
  const helper = value.manifest.files.find(
    ({ path: relative }) => relative.endsWith("sync-lock-root-analysis.mjs"),
  )!;
  const helperFile = path.join(value.root, ...helper.path.split("/"));
  if (kind === "filter-hidden") {
    fs.writeFileSync(path.join(value.root, ".gitattributes"), `${helper.path} filter=hide\n`);
    fs.writeFileSync(path.join(value.root, "hide-filter.cjs"),
      "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);" +
      "process.stdin.on('end',()=>process.stdout.write(s.replace(/^modified-/,'reviewed-')));\n");
    git(value.root, "config", "filter.hide.clean", "node hide-filter.cjs");
    git(value.root, "config", "filter.hide.required", "true");
    git(value.root, "add", ".gitattributes", "hide-filter.cjs");
    git(value.root, "commit", "-q", "-m", "filter fixture");
    harnessSha = git(value.root, "rev-parse", "HEAD");
  }
  const manifest = createImmutableHarnessManifest(value.root, harnessSha);
  if (kind === "assume-unchanged") {
    git(value.root, "update-index", "--assume-unchanged", "--", helper.path);
  } else if (kind === "skip-worktree") {
    git(value.root, "update-index", "--skip-worktree", "--", helper.path);
  }
  if (kind === "filter-hidden") {
    const original = fs.readFileSync(helperFile);
    const changed = Buffer.from(original.toString("utf8").replace(/^reviewed-/u, "modified-"));
    const manifestHelper = manifest.files.find(({ path: relative }) => relative === helper.path)!;
    expect(changed).not.toEqual(original);
    expect(changed.length).toBe(original.length);
    fs.writeFileSync(helperFile, changed);
    expect(sha256(changed)).not.toBe(manifestHelper.sha256);
    expect(gitInput(value.root, changed, "hash-object", "--stdin", `--path=${helper.path}`))
      .toBe(manifestHelper.blob);
    expect(gitInput(value.root, changed, "hash-object", "--stdin", "--no-filters"))
      .not.toBe(manifestHelper.blob);
  } else {
    fs.appendFileSync(helperFile, "modified\n");
  }
  expect(git(value.root, "status", "--porcelain", "--", helper.path)).toBe("");
  return { ...value, manifest };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sync lockRoot immutable harness bytes", () => {
  it("admits the exact working files and exact materialized capture launcher", () => {
    const value = fixture();
    expect(assertHarnessBytesMatchManifest(value.root, value.launcher, value.manifest))
      .toBe(value.manifest);
  });

  it.each(["assume-unchanged", "skip-worktree", "filter-hidden"] as const)(
    "rejects a %s helper mutation independently of index metadata",
    (kind) => {
      const value = hiddenGitMutation(kind);
      expect(() => assertHarnessBytesMatchManifest(value.root, value.launcher, value.manifest))
        .toThrow(/differ from reviewed blob/u);
    },
  );

  it("rejects a modified executed capture even when the checkout remains exact", () => {
    const value = fixture();
    fs.appendFileSync(value.launcher, "modified\n");
    expect(() => assertHarnessBytesMatchManifest(value.root, value.launcher, value.manifest))
      .toThrow(/executed capture launcher/u);
  });

  it("rejects a modified checkout capture even when the immutable launcher remains exact", () => {
    const value = fixture();
    fs.appendFileSync(path.join(value.root, ...SYNC_LOCK_ROOT_CAPTURE_PATH.split("/")),
      "modified\n");
    expect(() => assertHarnessBytesMatchManifest(value.root, value.launcher, value.manifest))
      .toThrow(/differ from reviewed blob/u);
  });

  it.each(["commit", "tree", "blob"] as const)(
    "ignores a %s replacement while retaining the claimed harness commit and helper bytes",
    (kind) => {
      const value = replacementFixture(kind);
      const manifest = withGitEnvironment(value.environment, () =>
        createImmutableHarnessManifest(value.root, value.harnessSha));
      const helper = manifest.files.find(({ path: relative }) => relative === value.targetPath)!;
      const workflow = manifest.files.find(({ path: relative }) => relative === value.workflowPath)!;
      expect(manifest.harnessSha).toBe(value.harnessSha);
      expect(helper.blob).toBe(value.originalBlob);
      expect(helper.sha256).toBe(sha256(value.originalBytes));
      expect(workflow.blob).toBe(value.originalWorkflowBlob);
      expect(workflow.sha256).toBe(sha256(value.originalWorkflowBytes));
    },
  );

  it.each(["namespaced", "alternate-base", "configured"] as const)(
    "ignores %s replacement routing while deriving helper expectations",
    (kind) => {
      const value = replacementFixture(kind);
      const manifest = withGitEnvironment(value.environment, () =>
        createImmutableHarnessManifest(value.root, value.harnessSha));
      const helper = manifest.files.find(({ path: relative }) => relative === value.targetPath)!;
      expect(helper.blob).toBe(value.originalBlob);
      expect(helper.sha256).toBe(sha256(value.originalBytes));
    },
  );

  it("leaves replacement lookup unchanged for a bare Git namespace", () => {
    const value = replacementFixture("namespaced");
    const bareNamespace = { GIT_NAMESPACE: "proof" };
    expect(gitAllowReplacements(value.root, bareNamespace, "cat-file", "blob",
      `${value.harnessSha}:${value.targetPath}`)).toEqual(value.originalBytes);
    const manifest = withGitEnvironment(bareNamespace, () =>
      createImmutableHarnessManifest(value.root, value.harnessSha));
    const helper = manifest.files.find(({ path: relative }) => relative === value.targetPath)!;
    expect(helper.blob).toBe(value.originalBlob);
    expect(helper.sha256).toBe(sha256(value.originalBytes));
  });

  it("rejects replacement helper bytes in an otherwise exact reviewed checkout", () => {
    const value = replacementFixture("blob");
    const substitutedHelper = gitAllowReplacements(value.root, value.environment,
      "cat-file", "blob", `${value.harnessSha}:${value.targetPath}`);
    fs.writeFileSync(path.join(value.root, ...value.targetPath.split("/")), substitutedHelper);
    expect(fs.readFileSync(path.join(value.root, ...value.workflowPath.split("/"))))
      .toEqual(value.originalWorkflowBytes);

    const manifest = withGitEnvironment(value.environment, () =>
      createImmutableHarnessManifest(value.root, value.harnessSha));
    const helper = manifest.files.find(({ path: relative }) => relative === value.targetPath)!;
    const workflow = manifest.files.find(({ path: relative }) => relative === value.workflowPath)!;
    expect(helper.blob).toBe(value.originalBlob);
    expect(helper.sha256).toBe(sha256(value.originalBytes));
    expect(workflow.blob).toBe(value.originalWorkflowBlob);
    expect(workflow.sha256).toBe(sha256(value.originalWorkflowBytes));
    expect(() => assertHarnessBytesMatchManifest(value.root, value.launcher, manifest))
      .toThrow(`harness input bytes differ from reviewed blob: ${value.targetPath}`);
  });

  it("derives the workflow receipt from the unreplaced immutable blob", () => {
    const targetPath = ".github/workflows/sync-lock-root-performance-proof.yml";
    const value = replacementFixture("blob", targetPath);
    const manifest = createImmutableHarnessManifest(value.root, value.harnessSha);
    const workflow = manifest.files.find(({ path: relative }) => relative === targetPath)!;
    expect(manifest.harnessSha).toBe(value.harnessSha);
    expect(workflow.blob).toBe(value.originalBlob);
    expect(workflow.sha256).toBe(sha256(value.originalBytes));
  });
});
