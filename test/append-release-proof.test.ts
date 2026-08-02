import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendReleaseProof, parseArguments } from "../scripts/append-release-proof.mjs";

const temporaryDirectories: string[] = [];

async function releaseFiles() {
  const directory = await mkdtemp(join(tmpdir(), "fs-safe-release-proof-test-"));
  temporaryDirectories.push(directory);
  const notesPath = join(directory, "notes.md");
  const manifestPath = join(directory, "manifest.json");
  await writeFile(notesPath, "# Release\n", "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify([
      {
        name: "@openclaw/fs-safe",
        version: "9.9.9",
        integrity: "sha512-test",
        size: 42,
      },
    ])}\n`,
    "utf8",
  );
  return { manifestPath, notesPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("append-release-proof", () => {
  it("uses the shared verifier and appends verified registry evidence", async () => {
    const files = await releaseFiles();
    const proof = {
      attestationUrl: "https://registry.npmjs.org/-/npm/v1/attestations/proof",
      integrity: "sha512-verified",
      spec: "@openclaw/fs-safe@9.9.9",
      tarballUrl: "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-9.9.9.tgz",
    };
    const verifyPackage = vi.fn(async () => proof);
    const wait = vi.fn();

    await expect(
      appendReleaseProof({
        ...files,
        repository: "openclaw/fs-safe",
        retryDelaysMs: [5, 10],
        runId: "12345",
        verifyPackage,
        wait,
      }),
    ).resolves.toEqual([proof]);

    expect(verifyPackage).toHaveBeenCalledWith(
      expect.objectContaining({ name: "@openclaw/fs-safe", version: "9.9.9" }),
      expect.objectContaining({ retryDelaysMs: [5, 10], wait }),
    );
    const notes = await readFile(files.notesPath, "utf8");
    expect(notes).toContain("| Package | Registry tarball | Verified integrity | Provenance |");
    expect(notes).toContain("[verified attestation](https://registry.npmjs.org/-/npm/v1/attestations/proof)");
    expect(notes).toContain("https://github.com/openclaw/fs-safe/actions/runs/12345");
  });

  it("does not append incomplete proof when registry verification fails", async () => {
    const files = await releaseFiles();

    await expect(
      appendReleaseProof({
        ...files,
        repository: "openclaw/fs-safe",
        runId: "12345",
        verifyPackage: vi.fn(async () => {
          throw new Error("provenance did not verify");
        }),
      }),
    ).rejects.toThrow("provenance did not verify");
    await expect(readFile(files.notesPath, "utf8")).resolves.toBe("# Release\n");
  });

  it("rejects malformed manifests and parses exactly four CLI arguments", async () => {
    const files = await releaseFiles();
    await writeFile(files.manifestPath, "{}\n", "utf8");
    await expect(
      appendReleaseProof({ ...files, repository: "openclaw/fs-safe", runId: "12345" }),
    ).rejects.toThrow("release manifest must be a non-empty array");

    expect(parseArguments(["notes.md", "manifest.json", "openclaw/fs-safe", "12345"])).toEqual({
      manifestPath: "manifest.json",
      notesPath: "notes.md",
      repository: "openclaw/fs-safe",
      runId: "12345",
    });
    expect(() => parseArguments([])).toThrow("usage: append-release-proof");
    expect(() => parseArguments(["a", "b", "c", "d", "e"])).toThrow(
      "usage: append-release-proof",
    );
  });
});
