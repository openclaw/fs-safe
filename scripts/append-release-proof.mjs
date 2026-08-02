import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPublishedPackage } from "./npm-registry-verification.mjs";

export function parseArguments(argv) {
  const [notesPath, manifestPath, repository, runId] = argv;
  if (!notesPath || !manifestPath || !repository || !runId || argv.length !== 4) {
    throw new Error("usage: append-release-proof <notes> <manifest> <repository> <run-id>");
  }
  return { manifestPath, notesPath, repository, runId };
}

export async function appendReleaseProof({
  appendFile = appendFileSync,
  fetchImpl = fetch,
  log = console.log,
  manifestPath,
  notesPath,
  readFile = readFileSync,
  repository,
  retryDelaysMs,
  runId,
  verifyBundle,
  verifyPackage = verifyPublishedPackage,
  wait,
}) {
  const manifest = JSON.parse(readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error("release manifest must be a non-empty array");
  }
  const lines = [
    "",
    "### Published packages",
    "",
    "| Package | Registry tarball | Verified integrity | Provenance |",
    "|---|---|---|---|",
  ];
  const proofs = [];
  for (const artifact of manifest) {
    const proof = await verifyPackage(artifact, {
      fetchImpl,
      log,
      retryDelaysMs,
      verifyBundle,
      wait,
    });
    proofs.push(proof);
    lines.push(
      `| [${proof.spec}](https://www.npmjs.com/package/${artifact.name}/v/${artifact.version}) | ` +
        `[tgz](${proof.tarballUrl}) | \`${proof.integrity}\` | ` +
        `[verified attestation](${proof.attestationUrl}) |`,
    );
  }
  lines.push(
    "",
    `Release proof: [GitHub Actions run](https://github.com/${repository}/actions/runs/${runId}).`,
    "",
  );
  appendFile(notesPath, `${lines.join("\n")}\n`);
  return proofs;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
  await appendReleaseProof(parseArguments(process.argv.slice(2)));
}
