import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REGISTRY_RETRY_DELAYS_MS } from "../scripts/npm-registry-verification.mjs";
import { publishOrVerify } from "../scripts/publish-or-verify.mjs";
import { publishReleasePackages } from "../scripts/publish-release-packages.mjs";

const temporaryDirectories: string[] = [];
const NOMINAL_NON_SLEEP_HEADROOM_MS = 19 * 60_000 + 20_000;

async function releaseArtifacts(packageNames: readonly string[]) {
  const directory = await mkdtemp(join(tmpdir(), "fs-safe-publish-release-test-"));
  temporaryDirectories.push(directory);
  const filenames = new Map<string, string>();
  const manifest = [];
  for (const [index, name] of packageNames.entries()) {
    const bytes = Buffer.from(`${name} validated tarball bytes`);
    const filename = `package-${index}.tgz`;
    filenames.set(name, filename);
    await writeFile(join(directory, filename), bytes);
    manifest.push({
      filename,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      name,
      size: bytes.length,
      version: "9.9.9",
    });
  }
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  return { directory, filenames };
}

function workflowJob(workflow: string, jobName: string): string {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`release workflow has no ${jobName} job`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/\n  [a-z][a-z0-9-]*:\n/u);
  return workflow.slice(start, nextJob < 0 ? workflow.length : start + marker.length + nextJob);
}

function timeoutMinutes(job: string): number {
  const match = job.match(/^    timeout-minutes: ([0-9]+)$/mu);
  if (!match) throw new Error("release job has no literal timeout-minutes value");
  return Number(match[1]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("publish-release-packages", () => {
  it("publishes every platform package before exposing the root package", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fs-safe-publish-release-test-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify([
        { name: "@openclaw/fs-safe" },
        { name: "@openclaw/fs-safe-darwin-arm64" },
        { name: "@openclaw/fs-safe-linux-x64-gnu" },
      ]),
    );
    const publish = vi.fn(async () => undefined);

    await publishReleasePackages({ artifactsDir: directory, publish });

    expect(publish.mock.calls.map(([options]) => options)).toEqual([
      { packageName: "@openclaw/fs-safe-darwin-arm64", artifactsDir: resolve(directory) },
      { packageName: "@openclaw/fs-safe-linux-x64-gnu", artifactsDir: resolve(directory) },
      { packageName: "@openclaw/fs-safe", artifactsDir: resolve(directory) },
    ]);
  });

  it("resumes through verified packages without republishing them", async () => {
    const packageNames = [
      "@openclaw/fs-safe",
      "@openclaw/fs-safe-darwin-arm64",
      "@openclaw/fs-safe-linux-x64-gnu",
    ];
    const artifacts = await releaseArtifacts(packageNames);
    const existingPackage = "@openclaw/fs-safe-darwin-arm64";
    const spawnNpm = vi.fn((_command: string, _arguments: string[]) => ({ status: 0 }));
    const verifyPackage = vi.fn(async (artifact, options) => {
      if (artifact.name !== existingPackage) await options.onVersionMissing();
      return { byteEvidence: "packument-integrity" };
    });
    const publish = vi.fn((options) =>
      publishOrVerify({
        ...options,
        log: vi.fn(),
        spawnNpm,
        verifyPackage,
      }),
    );

    await publishReleasePackages({ artifactsDir: artifacts.directory, publish });

    expect(verifyPackage.mock.calls.map(([artifact]) => artifact.name)).toEqual([
      existingPackage,
      "@openclaw/fs-safe-linux-x64-gnu",
      "@openclaw/fs-safe",
    ]);
    expect(spawnNpm.mock.calls.map(([, arguments_]) => arguments_[1])).toEqual([
      resolve(artifacts.directory, artifacts.filenames.get("@openclaw/fs-safe-linux-x64-gnu")!),
      resolve(artifacts.directory, artifacts.filenames.get("@openclaw/fs-safe")!),
    ]);
  });

  it("pins both 90-minute caps and their nominal headroom over retry sleeps", async () => {
    const workflow = (await readFile(".github/workflows/release.yml", "utf8")).replaceAll("\r\n", "\n");
    const platformPackageCount = (await readdir("packages", { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    ).length;
    const releasePackageCount = platformPackageCount + 1;
    const perPackageRetrySleepMs = REGISTRY_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
    const sequentialRetrySleepMs = releasePackageCount * perPackageRetrySleepMs;

    expect(releasePackageCount).toBe(8);
    expect(perPackageRetrySleepMs).toBe(530_000);
    expect(sequentialRetrySleepMs).toBe(4_240_000);
    for (const [jobName, command] of [
      ["publish", "node scripts/publish-release-packages.mjs release-artifacts"],
      ["release", "node scripts/append-release-proof.mjs"],
    ] as const) {
      const job = workflowJob(workflow, jobName);
      const jobTimeoutMinutes = timeoutMinutes(job);
      const timeoutMs = jobTimeoutMinutes * 60_000;
      expect(job).toContain(command);
      expect(jobTimeoutMinutes).toBe(90);
      expect(timeoutMs).toBe(5_400_000);
      expect(timeoutMs).toBe(sequentialRetrySleepMs + NOMINAL_NON_SLEEP_HEADROOM_MS);
      expect(timeoutMs).toBeGreaterThan(sequentialRetrySleepMs);
    }
  });
});
