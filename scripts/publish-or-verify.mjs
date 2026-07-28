import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REGISTRY_RETRY_DELAYS_MS = [
  5_000,
  10_000,
  20_000,
  30_000,
  45_000,
  60_000,
  60_000,
  60_000,
  60_000,
  60_000,
  60_000,
  60_000,
];

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function loadReleaseArtifact(packageName, artifactsDirectory) {
  const artifactsDir = resolve(artifactsDirectory);
  const manifest = JSON.parse(readFileSync(join(artifactsDir, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest)) throw new Error("release manifest must be an array");

  const artifact = manifest.find((entry) => entry?.name === packageName);
  if (!artifact) throw new Error(`release manifest has no entry for ${packageName}`);
  if (
    typeof artifact.version !== "string" ||
    typeof artifact.filename !== "string" ||
    basename(artifact.filename) !== artifact.filename
  ) {
    throw new Error(`release manifest has invalid artifact metadata for ${packageName}`);
  }

  const artifactPath = resolve(artifactsDir, artifact.filename);
  if (dirname(artifactPath) !== artifactsDir) {
    throw new Error(`release artifact escapes artifacts directory: ${artifact.filename}`);
  }

  const bytes = readFileSync(artifactPath);
  const integrity = sha512Integrity(bytes);
  if (integrity !== artifact.integrity) {
    throw new Error(`${packageName}@${artifact.version} artifact bytes do not match release manifest`);
  }
  if (Number.isSafeInteger(artifact.size) && bytes.length !== artifact.size) {
    throw new Error(`${packageName}@${artifact.version} artifact size does not match release manifest`);
  }

  return { ...artifact, path: artifactPath, integrity };
}

function registryState(artifact, execNpm) {
  const spec = `${artifact.name}@${artifact.version}`;
  try {
    const raw = execNpm("npm", ["view", spec, "dist", "--json", "--prefer-online"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const dist = JSON.parse(raw);
    if (dist.integrity !== artifact.integrity) {
      return { state: "pending", reason: "registry reports different package bytes" };
    }
    if (!dist.attestations?.url) {
      return { state: "pending", reason: "registry has not exposed npm provenance" };
    }
    return { state: "verified" };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (stderr.includes("E404")) return { state: "missing", reason: "version is not visible" };
    return { state: "pending", reason: error instanceof Error ? error.message : String(error) };
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function publishOrVerify({
  packageName,
  artifactsDir,
  execNpm = execFileSync,
  spawnNpm = spawnSync,
  retryDelaysMs = REGISTRY_RETRY_DELAYS_MS,
  wait = sleep,
  log = console.log,
}) {
  if (!packageName) throw new Error("--package is required");
  const artifact = loadReleaseArtifact(packageName, artifactsDir);
  const spec = `${artifact.name}@${artifact.version}`;
  let publishResult;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const registry = registryState(artifact, execNpm);
    if (registry.state === "verified") {
      log(`verified ${spec} byte identity and provenance`);
      return;
    }

    if (registry.state === "missing" && publishResult === undefined) {
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
    }

    if (attempt === retryDelaysMs.length) {
      const publishSummary =
        publishResult === undefined ? "npm publish was not attempted" : `npm publish exited ${publishResult.status}`;
      throw new Error(`${publishSummary}; registry never confirmed ${spec}: ${registry.reason}`);
    }

    const delayMs = retryDelaysMs[attempt];
    log(
      `registry verification attempt ${attempt + 1}/${retryDelaysMs.length + 1} has not confirmed ${spec}` +
        ` (${registry.reason}); retrying in ${delayMs / 1_000}s`,
    );
    await wait(delayMs);
  }
}

function parseArguments(argv) {
  const packageIndex = argv.indexOf("--package");
  const artifactsIndex = argv.indexOf("--artifacts");
  return {
    packageName: packageIndex >= 0 ? argv[packageIndex + 1] : undefined,
    artifactsDir: resolve(artifactsIndex >= 0 ? argv[artifactsIndex + 1] : "release-artifacts"),
  };
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  await publishOrVerify(parseArguments(process.argv.slice(2)));
}
