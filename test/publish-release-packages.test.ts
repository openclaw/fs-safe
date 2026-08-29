import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishReleasePackages } from "../scripts/publish-release-packages.mjs";

const temporaryDirectories: string[] = [];

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
});
