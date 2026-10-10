import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REGISTRY_RETRY_DELAYS_MS } from "../scripts/npm-registry-verification.mjs";
import { publishOrVerify } from "../scripts/publish-or-verify.mjs";
import { publishReleasePackages } from "../scripts/publish-release-packages.mjs";
import { RELEASE_PACKAGE_CONCURRENCY } from "../scripts/release-package-batches.mjs";

const temporaryDirectories: string[] = [];

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

  it("finishes all platform verification before publishing root, with at most four in flight", async () => {
    const platforms = Array.from({ length: 11 }, (_, index) => `@openclaw/fs-safe-platform-${index}`);
    const artifacts = await releaseArtifacts(["@openclaw/fs-safe", ...platforms]);
    const completed: string[] = [];
    let active = 0;
    let maximum = 0;
    await publishReleasePackages({ artifactsDir: artifacts.directory, publish: async ({ packageName }) => {
      if (packageName === "@openclaw/fs-safe") expect(completed).toEqual(platforms);
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      completed.push(packageName);
    } });
    expect(maximum).toBe(4);
    expect(completed).toEqual([...platforms, "@openclaw/fs-safe"]);
  });

  it("never publishes root or later batches after a platform verification failure", async () => {
    const platforms = Array.from({ length: 11 }, (_, index) => `@openclaw/fs-safe-platform-${index}`);
    const artifacts = await releaseArtifacts(["@openclaw/fs-safe", ...platforms]);
    const publish = vi.fn(async ({ packageName }) => {
      if (packageName === platforms[1]) throw new Error("provenance mismatch");
    });
    await expect(publishReleasePackages({ artifactsDir: artifacts.directory, publish })).rejects.toThrow("provenance mismatch");
    expect(publish.mock.calls.map(([options]) => options.packageName)).toEqual(platforms.slice(0, 4));
  });

  it("keeps both 90-minute caps with bounded retry sleeps for expanded manifests", async () => {
    const workflow = (await readFile(".github/workflows/release.yml", "utf8")).replaceAll("\r\n", "\n");
    const platformPackageCount = (await readdir("packages", { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    ).length;
    const perPackageRetrySleepMs = REGISTRY_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);

    expect(perPackageRetrySleepMs).toBe(530_000);
    expect(RELEASE_PACKAGE_CONCURRENCY).toBe(4);
    expect(11 * perPackageRetrySleepMs).toBe(5_830_000);
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
      for (const count of [platformPackageCount, 10, 11]) {
        const schedules = jobName === "publish"
          ? Math.ceil(count / RELEASE_PACKAGE_CONCURRENCY) + 1
          : Math.ceil((count + 1) / RELEASE_PACKAGE_CONCURRENCY);
        const retrySleepMs = schedules * perPackageRetrySleepMs;
        if (count >= 10) expect(retrySleepMs).toBe(jobName === "publish" ? 2_120_000 : 1_590_000);
        expect(timeoutMs - retrySleepMs).toBeGreaterThanOrEqual(3_280_000);
      }
    }
  });
});
