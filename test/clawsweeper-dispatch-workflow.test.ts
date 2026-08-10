import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const behaviorIt = process.platform === "win32" ? it.skip : it;

function exactReviewBlock(workflow: string) {
  const start = workflow.indexOf("      - name: Dispatch exact ClawSweeper review");
  const end = workflow.indexOf("      - name: Acknowledge and dispatch ClawSweeper comment");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function exactReviewRun(workflow: string) {
  const match = exactReviewBlock(workflow).match(/\n        run: \|\r?\n([\s\S]*)$/u);
  expect(match).not.toBeNull();
  return (match?.[1] ?? "")
    .split(/\r?\n/u)
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
    .trimEnd();
}

function executeExactReview(run: string, event: object, environment: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "fs-safe-clawsweeper-dispatch-"));
  const eventPath = join(directory, "event.json");
  const capturePath = join(directory, "dispatch.json");
  const scriptPath = join(directory, "dispatch.sh");
  const ghPath = join(directory, "gh");

  try {
    writeFileSync(eventPath, JSON.stringify(event), "utf8");
    writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${run}\n`, "utf8");
    writeFileSync(
      ghPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'test "$#" -eq 6',
        'test "$1" = "api"',
        'test "$2" = "repos/openclaw/clawsweeper/dispatches"',
        'test "$3" = "--method"',
        'test "$4" = "POST"',
        'test "$5" = "--input"',
        'test "$6" = "-"',
        'cat > "$GH_CAPTURE"',
      ].join("\n"),
      "utf8",
    );
    chmodSync(scriptPath, 0o755);
    chmodSync(ghPath, 0o755);

    const result = spawnSync("bash", [scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...environment,
        GH_CAPTURE: capturePath,
        GH_TOKEN: "proof-token",
        GITHUB_EVENT_PATH: eventPath,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        SUPERSEDES_IN_PROGRESS: "false",
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return JSON.parse(readFileSync(capturePath, "utf8")) as {
      event_type: string;
      client_payload: Record<string, unknown>;
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("ClawSweeper dispatch workflow", () => {
  it("carries trusted branch authority and canonical PR ingress identity", async () => {
    const workflow = await readFile(".github/workflows/clawsweeper-dispatch.yml", "utf8");
    const exactReview = exactReviewBlock(workflow);

    expect(exactReview).toContain(
      "if: ${{ steps.trust.outputs.allowed == 'true' && github.event_name != 'issue_comment' }}",
    );
    expect(exactReview).toContain(
      "TARGET_BRANCH: ${{ github.event.repository.default_branch }}",
    );
    expect(exactReview).toContain('--arg target_branch "$TARGET_BRANCH"');
    expect(exactReview).toContain("target_branch:$target_branch");
    expect(exactReview).toContain('process.env.ITEM_KIND !== "pull_request"');
    expect(exactReview).toContain('/^[0-9a-f]{40}$/.test(headSha)');
    expect(exactReview).toContain("version: 1");
    expect(exactReview).toContain(
      'target_repo: String(process.env.TARGET_REPO || "").toLowerCase()',
    );
    expect(exactReview).toContain("item_number: Number(process.env.ITEM_NUMBER)");
    expect(exactReview).toContain('action: String(process.env.SOURCE_ACTION || "")');
    expect(exactReview).toContain("head_sha: headSha");
    expect(exactReview).toContain("updated_at: updatedAt");
    expect(exactReview).toContain(
      'body: typeof pullRequest.body === "string" ? pullRequest.body : ""',
    );
    expect(exactReview).toContain('label: String(event.label?.name || "")');
    expect(exactReview).toContain('ingress_route:"target_dispatcher"');
    expect(exactReview).toContain("ingress_fingerprint:$ingress_fingerprint");
    expect(exactReview).not.toContain('target_branch || "main"');
  });

  behaviorIt("serializes PR identity and leaves issue dispatches unpaired", async () => {
    const workflow = await readFile(".github/workflows/clawsweeper-dispatch.yml", "utf8");
    const run = exactReviewRun(workflow);
    const pullRequest = {
      head: { sha: "B".repeat(40) },
      updated_at: "2026-08-10T22:00:00Z",
      body: "proof body",
    };
    const prPayload = executeExactReview(
      run,
      { pull_request: pullRequest, label: { name: "proof: sufficient" } },
      {
        TARGET_REPO: "openclaw/fs-safe",
        TARGET_BRANCH: "stable",
        ITEM_NUMBER: "445",
        ITEM_KIND: "pull_request",
        SOURCE_EVENT: "pull_request_target",
        SOURCE_ACTION: "synchronize",
      },
    );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          target_repo: "openclaw/fs-safe",
          item_number: 445,
          action: "synchronize",
          head_sha: "b".repeat(40),
          updated_at: pullRequest.updated_at,
          body: pullRequest.body,
          label: "proof: sufficient",
        }),
      )
      .digest("hex");
    expect(prPayload).toEqual({
      event_type: "clawsweeper_item",
      client_payload: {
        target_repo: "openclaw/fs-safe",
        target_branch: "stable",
        item_number: 445,
        item_kind: "pull_request",
        source_event: "pull_request_target",
        source_action: "synchronize",
        supersedes_in_progress: false,
        ingress_route: "target_dispatcher",
        ingress_fingerprint: fingerprint,
      },
    });

    const issuePayload = executeExactReview(
      run,
      { issue: { number: 446 } },
      {
        TARGET_REPO: "openclaw/fs-safe",
        TARGET_BRANCH: "stable",
        ITEM_NUMBER: "446",
        ITEM_KIND: "issue",
        SOURCE_EVENT: "issues",
        SOURCE_ACTION: "opened",
      },
    );
    expect(issuePayload.client_payload).toEqual({
      target_repo: "openclaw/fs-safe",
      target_branch: "stable",
      item_number: 446,
      item_kind: "issue",
      source_event: "issues",
      source_action: "opened",
      supersedes_in_progress: false,
    });
  });
});
