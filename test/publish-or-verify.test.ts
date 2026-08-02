import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REGISTRY_RETRY_DELAYS_MS,
  loadReleaseArtifact,
  parseArguments,
  publishOrVerify,
} from "../scripts/publish-or-verify.mjs";

const temporaryDirectories: string[] = [];

async function releaseArtifact(
  bytes = Buffer.from("validated tarball bytes"),
  overrides: Record<string, unknown> = {},
) {
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
        ...overrides,
      },
    ])}\n`,
  );
  return { bytes, directory, filename, integrity };
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

  it("rejects artifact size mismatches and paths escaping the artifact directory", async () => {
    const wrongSize = await releaseArtifact(undefined, { size: 1 });
    expect(() => loadReleaseArtifact("@openclaw/fs-safe", wrongSize.directory)).toThrow(
      "artifact size does not match release manifest",
    );

    const escaped = await releaseArtifact(undefined, { filename: "../outside.tgz" });
    expect(() => loadReleaseArtifact("@openclaw/fs-safe", escaped.directory)).toThrow(
      "release artifact escapes artifacts directory",
    );
  });

  it("publishes the exact validated tarball after a missing-version result", async () => {
    const artifact = await releaseArtifact();
    const spawnNpm = vi.fn(() => ({ status: 0 }));
    const proof = { byteEvidence: "packument-integrity" };
    const verifyPackage = vi.fn(async (_entry, options) => {
      await options.onVersionMissing();
      return proof;
    });
    const log = vi.fn();

    await expect(
      publishOrVerify({
        packageName: "@openclaw/fs-safe",
        artifactsDir: artifact.directory,
        log,
        spawnNpm,
        verifyPackage,
      }),
    ).resolves.toBe(proof);

    expect(spawnNpm).toHaveBeenCalledWith(
      "npm",
      ["publish", resolve(artifact.directory, artifact.filename), "--access", "public", "--provenance"],
      { stdio: "inherit" },
    );
    expect(log).toHaveBeenCalledWith(
      "verified @openclaw/fs-safe@9.9.9 byte identity, registry signature, and provenance (packument-integrity)",
    );
  });

  it("does not republish an existing verified version", async () => {
    const artifact = await releaseArtifact();
    const spawnNpm = vi.fn(() => ({ status: 0 }));
    const verifyPackage = vi.fn(async () => ({ byteEvidence: "canonical-tarball" }));

    await publishOrVerify({
      packageName: "@openclaw/fs-safe",
      artifactsDir: artifact.directory,
      spawnNpm,
      verifyPackage,
    });

    expect(spawnNpm).not.toHaveBeenCalled();
  });

  it.each([
    [{ error: new Error("spawn failed"), status: null }, "npm publish could not start"],
    [{ status: 17 }, "npm publish exited 17"],
  ])("reports publish failure while continuing registry verification", async (publishResult, summary) => {
    const artifact = await releaseArtifact();
    const verifyPackage = vi.fn(async (_entry, options) => {
      await options.onVersionMissing();
      throw new Error("registry verification exhausted 2 attempts");
    });

    await expect(
      publishOrVerify({
        packageName: "@openclaw/fs-safe",
        artifactsDir: artifact.directory,
        spawnNpm: vi.fn(() => publishResult),
        verifyPackage,
      }),
    ).rejects.toThrow(`${summary}; registry did not verify @openclaw/fs-safe@9.9.9`);
  });

  it("exhausts the configured attempts, publishes once, and preserves the final reason", async () => {
    const artifact = await releaseArtifact();
    const fetchImpl = vi.fn(async () => new Response("missing", { status: 404 }));
    const spawnNpm = vi.fn(() => ({ status: 0 }));
    const wait = vi.fn(async () => undefined);

    await expect(
      publishOrVerify({
        packageName: "@openclaw/fs-safe",
        artifactsDir: artifact.directory,
        fetchImpl,
        retryDelaysMs: [5, 10],
        spawnNpm,
        wait,
      }),
    ).rejects.toThrow(
      "npm publish exited 0; registry did not verify @openclaw/fs-safe@9.9.9: registry verification exhausted 3 attempts",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(spawnNpm).toHaveBeenCalledOnce();
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([5, 10]);
  });

  it("parses CLI arguments and retains the production retry budget", () => {
    expect(parseArguments(["--package", "@openclaw/fs-safe", "--artifacts", "proof"])).toEqual({
      artifactsDir: resolve("proof"),
      packageName: "@openclaw/fs-safe",
    });
    expect(parseArguments([])).toEqual({
      artifactsDir: resolve("release-artifacts"),
      packageName: undefined,
    });
    expect(() => parseArguments(["--package"])).toThrow("invalid argument: --package");
    expect(() => parseArguments(["--unknown", "value"])).toThrow("invalid argument: --unknown");
    expect(REGISTRY_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)).toBe(530_000);
  });
});
