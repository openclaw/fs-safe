import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  REGISTRY_RETRY_DELAYS_MS,
  sha512Integrity,
  verifyPublishedPackage,
} from "./npm-registry-verification.mjs";

export { REGISTRY_RETRY_DELAYS_MS };

export function loadReleaseArtifact(packageName, artifactsDirectory) {
  const artifactsDir = resolve(artifactsDirectory);
  const manifest = JSON.parse(readFileSync(join(artifactsDir, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest)) throw new Error("release manifest must be an array");

  const artifact = manifest.find((entry) => entry?.name === packageName);
  if (!artifact) throw new Error(`release manifest has no entry for ${packageName}`);
  if (typeof artifact.version !== "string" || typeof artifact.filename !== "string") {
    throw new Error(`release manifest has invalid artifact metadata for ${packageName}`);
  }

  const artifactPath = resolve(artifactsDir, artifact.filename);
  if (basename(artifact.filename) !== artifact.filename || dirname(artifactPath) !== artifactsDir) {
    throw new Error(`release artifact escapes artifacts directory: ${artifact.filename}`);
  }

  const bytes = readFileSync(artifactPath);
  const integrity = sha512Integrity(bytes);
  if (integrity !== artifact.integrity) {
    throw new Error(`${packageName}@${artifact.version} artifact bytes do not match release manifest`);
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
    throw new Error(`${packageName}@${artifact.version} release manifest has invalid artifact size`);
  }
  if (bytes.length !== artifact.size) {
    throw new Error(`${packageName}@${artifact.version} artifact size does not match release manifest`);
  }

  return { ...artifact, path: artifactPath, integrity };
}

export async function publishOrVerify({
  packageName,
  artifactsDir,
  fetchImpl = fetch,
  spawnNpm = spawnSync,
  retryDelaysMs = REGISTRY_RETRY_DELAYS_MS,
  verifyBundle,
  verifyPackage = verifyPublishedPackage,
  wait,
  log = console.log,
}) {
  if (!packageName) throw new Error("--package is required");
  const artifact = loadReleaseArtifact(packageName, artifactsDir);
  const spec = `${artifact.name}@${artifact.version}`;
  let publishResult;
  try {
    const proof = await verifyPackage(artifact, {
      fetchImpl,
      log,
      retryDelaysMs,
      verifyBundle,
      wait,
      onVersionMissing: async () => {
        publishResult = spawnNpm(
          "npm",
          ["publish", artifact.path, "--access", "public", "--provenance"],
          { stdio: "inherit" },
        );
        if (publishResult.error) {
          log(`npm publish could not start: ${publishResult.error.message}`);
        } else if (publishResult.status !== 0) {
          log(`npm publish exited ${publishResult.status}; checking whether the registry committed it`);
        }
      },
    });
    log(`verified ${spec} byte identity, registry signature, and provenance (${proof.byteEvidence})`);
    return proof;
  } catch (error) {
    const publishSummary =
      publishResult === undefined
        ? "npm publish was not attempted"
        : publishResult.error
          ? "npm publish could not start"
          : `npm publish exited ${String(publishResult.status)}`;
    throw new Error(`${publishSummary}; registry did not verify ${spec}: ${error.message}`, {
      cause: error,
    });
  }
}

export function parseArguments(argv) {
  let packageName;
  let artifacts = "release-artifacts";
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if ((option !== "--package" && option !== "--artifacts") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument: ${String(option)}`);
    }
    if (option === "--package") packageName = value;
    if (option === "--artifacts") artifacts = value;
  }
  return {
    packageName,
    artifactsDir: resolve(artifacts),
  };
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  await publishOrVerify(parseArguments(process.argv.slice(2)));
}
