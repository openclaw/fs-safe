import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REGISTRY_RETRY_DELAYS_MS,
  loadReleaseArtifact,
  publishOrVerify,
} from "../scripts/publish-or-verify.mjs";

const temporaryDirectories: string[] = [];

async function releaseArtifact(bytes = Buffer.from("validated tarball bytes")) {
  const directory = await mkdtemp(join(tmpdir(), "fs-safe-publish-test-"));
  temporaryDirectories.push(directory);
  const filename = "openclaw-fs-safe-9.9.9.tgz";
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  await writeFile(join(directory, filename), bytes);
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify([
      {
        name: "@openclaw/fs-safe",
        version: "9.9.9",
        filename,
        integrity,
        size: bytes.length,
      },
    ])}\n`,
  );
  return { directory, filename, integrity };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("publish-or-verify", () => {
  it("rejects artifact bytes that differ from the validated manifest", async () => {
    const artifact = await releaseArtifact();
    await writeFile(join(artifact.directory, artifact.filename), "repacked bytes");

    expect(() => loadReleaseArtifact("@openclaw/fs-safe", artifact.directory)).toThrow(
      "artifact bytes do not match release manifest",
    );
  });

  it("publishes the exact validated tarball path and verifies its registry identity", async () => {
    const artifact = await releaseArtifact();
    const registryResponses = [
      Object.assign(new Error("missing"), { stderr: "npm error code E404" }),
      JSON.stringify({ integrity: "sha512-stale", attestations: { url: "https://example.test/stale" } }),
      JSON.stringify({ integrity: artifact.integrity, attestations: { url: "https://example.test/provenance" } }),
    ];
    const execNpm = vi.fn(() => {
      const response = registryResponses.shift();
      if (response instanceof Error) throw response;
      return response;
    });
    const spawnNpm = vi.fn(() => ({ status: 0 }));
    const wait = vi.fn(async () => undefined);

    await publishOrVerify({
      packageName: "@openclaw/fs-safe",
      artifactsDir: artifact.directory,
      execNpm,
      spawnNpm,
      retryDelaysMs: [5_000, 10_000],
      wait,
      log: vi.fn(),
    });

    expect(spawnNpm).toHaveBeenCalledOnce();
    expect(spawnNpm).toHaveBeenCalledWith(
      "npm",
      ["publish", resolve(artifact.directory, artifact.filename), "--access", "public", "--provenance"],
      { stdio: "inherit" },
    );
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([5_000, 10_000]);
  });

  it("backs off through transient mismatches without republishing an existing version", async () => {
    const artifact = await releaseArtifact();
    const execNpm = vi
      .fn()
      .mockReturnValueOnce(JSON.stringify({ integrity: "sha512-stale", attestations: {} }))
      .mockReturnValueOnce(JSON.stringify({ integrity: "sha512-stale", attestations: {} }))
      .mockReturnValueOnce(
        JSON.stringify({ integrity: artifact.integrity, attestations: { url: "https://example.test/provenance" } }),
      );
    const spawnNpm = vi.fn(() => ({ status: 0 }));
    const wait = vi.fn(async () => undefined);

    await publishOrVerify({
      packageName: "@openclaw/fs-safe",
      artifactsDir: artifact.directory,
      execNpm,
      spawnNpm,
      retryDelaysMs: [5_000, 10_000],
      wait,
      log: vi.fn(),
    });

    expect(spawnNpm).not.toHaveBeenCalled();
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([5_000, 10_000]);
    expect(REGISTRY_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)).toBeGreaterThanOrEqual(
      8 * 60_000,
    );
  });
});
