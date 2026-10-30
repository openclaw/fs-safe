import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
  .replace(/\r\n?/gu, "\n");
const jobs = Object.fromEntries([...workflow.slice(workflow.indexOf("jobs:\n")).matchAll(
  /^  ([a-z][a-z0-9-]*):\n((?: {4,}[^\n]*\n|\n)*)/gmu,
)].map((match) => [match[1]!, match[2]!]));

type Context = {
  event: string;
  capacity?: boolean;
  secure?: boolean;
  cancelled?: boolean;
  producerResult?: "success" | "failure" | "skipped";
};

// This typed boolean/event/JSON subset has the same semantics in JS and Actions.
// The native workflow dispatch separately proves the actual scheduler and artifacts.
function evaluate(expression: string, context: Context): unknown {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), {
    github: { event_name: context.event },
    inputs: { windows_package_capacity_proof: context.capacity, secure_file_credential_proof: context.secure },
    fromJSON: JSON.parse,
    cancelled: () => context.cancelled ?? false,
    always: () => true,
    success: () => (context.producerResult ?? "success") === "success",
    needs: { "package-smoke-build": { result: context.producerResult ?? "success" } },
  }, { timeout: 100 });
}

function admitted(name: string, context: Context): boolean {
  const condition = jobs[name]!.match(/^    if: (.+)$/mu)?.[1] ?? "true";
  return Boolean(evaluate(condition, context));
}

function axis(name: string, key: string, context: Context): string[] {
  const expression = jobs[name]!.match(new RegExp(`^        ${key}: (.+)$`, "mu"))?.[1];
  expect(expression).toBeDefined();
  return evaluate(expression!, context) as string[];
}

function consumers(context: Context) {
  const exclusions = [...jobs["package-smoke"]!.matchAll(
    /^          - os: (\S+)\n            capacity: (\S+)$/gmu,
  )].map((match) => ({ os: match[1]!, capacity: match[2]! }));
  return axis("package-smoke", "os", context).flatMap((os) =>
    nodes("package-smoke").map(Number).flatMap((node) => axis("package-smoke", "capacity", context)
      .filter((capacity) => !exclusions.some((entry) => entry.os === os && entry.capacity === capacity))
      .map((capacity) => ({ os, node, capacity }))));
}

function nodes(name: string): string[] {
  return [...jobs[name]!.matchAll(/^          - (\d+(?:\.\d+)*)$/gmu)]
    .map((match) => match[1]!);
}

const unrelated = {
  "freebsd-native": 3,
  "lint-workflows": 1,
  check: 9,
  "native-check": 7,
  "native-gnu-floor": 2,
  "native-musl": 2,
  "cargo-quality": 1,
  "windows-arm64": 2,
};
const credential = [
  "secure-file-credential-candidate-build",
  "secure-file-credential-historical-build",
  "secure-file-credential-proof",
];

describe("manual Windows package capacity closure", () => {
  it.each([
    ["ordinary PR", "pull_request", true, true, 36],
    ["main push", "push", true, true, 36],
    ["manual defaults", "workflow_dispatch", undefined, undefined, 36],
    ["manual flags false", "workflow_dispatch", false, false, 36],
    ["capacity only", "workflow_dispatch", true, false, 5],
    ["secure-file only", "workflow_dispatch", false, true, 42],
    ["both independent proofs", "workflow_dispatch", true, true, 11],
  ] as const)("preserves the %s graph", (_label, event, capacity, secure, expectedJobs) => {
    const context = { event, capacity, secure };
    expect(Object.keys(jobs).sort()).toEqual([
      ...Object.keys(unrelated), ...credential, "package-smoke-build", "package-smoke",
    ].sort());
    const otherRows = Object.entries(unrelated).reduce((sum, [name, count]) =>
      sum + (admitted(name, context) ? count : 0), 0);
    // Each unchanged secure-file owner has its own two-runtime matrix.
    const secureRows = credential.reduce((sum, name) =>
      sum + (admitted(name, context) ? nodes(name).length : 0), 0);
    const producerRows = axis("package-smoke-build", "os", context).length;
    expect(otherRows + secureRows + producerRows + consumers(context).length).toBe(expectedJobs);
    const expectedOS = event === "workflow_dispatch" && capacity
      ? ["windows-latest"] : ["ubuntu-latest", "xcode-27", "windows-latest"];
    expect(axis("package-smoke-build", "os", context)).toEqual(expectedOS);
    expect(axis("package-smoke", "os", context)).toEqual(expectedOS);
  });

  it("runs all four required consumers after a failed producer and fails missing artifacts", () => {
    const context = { event: "workflow_dispatch", capacity: true, producerResult: "failure" as const };
    expect(jobs["package-smoke"]).toMatch(/^    needs: package-smoke-build$/mu);
    expect(jobs["package-smoke"]).toContain("if: ${{ !cancelled() && (github.event_name != 'workflow_dispatch' || (!inputs.windows_workload_capacity_proof || inputs.windows_workload_capacity_proof == 'none')) }}");
    // No success()/needs-result gate may hide the required artifact failure.
    expect(admitted("package-smoke", context)).toBe(true);
    expect(admitted("package-smoke", { ...context, producerResult: "skipped" })).toBe(true);
    expect(consumers(context)).toEqual([
      { os: "windows-latest", node: 22, capacity: "standard" },
      { os: "windows-latest", node: 22, capacity: "control" },
      { os: "windows-latest", node: 24, capacity: "standard" },
      { os: "windows-latest", node: 24, capacity: "control" },
    ]);
    expect(admitted("package-smoke", { ...context, cancelled: true })).toBe(false);
    const download = jobs["package-smoke"]!.match(
      /      - name: Download exact-source package build\n([\s\S]*?)(?=      - name:)/u,
    )?.[1];
    expect(download).toContain("uses: actions/download-artifact@");
    expect(download).toContain("name: package-smoke-build-${{ matrix.os }}-${{ github.event.pull_request.head.sha || github.sha }}");
    expect(download).not.toMatch(/\n        (?:if|continue-on-error):/u);
  });

  it("keeps both proof inputs opt-in and secure-file admission independent", () => {
    expect(workflow).toMatch(/inputs:\n      secure_file_credential_proof:\n(?: {8}[^\n]*\n)*?        default: false\n        type: boolean\n      windows_package_capacity_proof:/u);
    for (const name of credential) {
      expect(jobs[name]).not.toContain("windows_package_capacity_proof");
      expect(jobs[name]).toMatch(/node:\n          - 22\.23\.4\n          - 24\.22\.1/u);
    }
    expect(jobs["secure-file-credential-proof"]).toContain("- secure-file-credential-candidate-build");
    expect(jobs["secure-file-credential-proof"]).toContain("- secure-file-credential-historical-build");
  });
});
