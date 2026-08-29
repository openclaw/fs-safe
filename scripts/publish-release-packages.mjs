import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publishOrVerify } from "./publish-or-verify.mjs";

export async function publishReleasePackages({
  artifactsDir = "release-artifacts",
  publish = publishOrVerify,
} = {}) {
  const directory = resolve(artifactsDir);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest) || manifest.length < 2) {
    throw new Error("release manifest must contain platform packages and the root package");
  }
  const rootPackages = manifest.filter((entry) => entry?.name === "@openclaw/fs-safe");
  if (rootPackages.length !== 1) {
    throw new Error("release manifest must contain exactly one @openclaw/fs-safe package");
  }
  const platformPackages = manifest.filter((entry) => entry?.name !== "@openclaw/fs-safe");
  for (const artifact of [...platformPackages, ...rootPackages]) {
    await publish({ packageName: artifact.name, artifactsDir: directory });
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  await publishReleasePackages({ artifactsDir: process.argv[2] });
}
