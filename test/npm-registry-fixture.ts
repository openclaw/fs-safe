import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { vi } from "vitest";
import {
  NPM_PROVENANCE_PREDICATE_TYPE,
  registryTarballUrl,
  registryVersionUrl,
} from "../scripts/npm-registry-verification.mjs";

export type TestArtifact = {
  integrity: string;
  name: string;
  size: number;
  version: string;
};

export function testArtifact(bytes = Buffer.from("validated tarball bytes")): TestArtifact {
  return {
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    name: "@openclaw/fs-safe",
    size: bytes.length,
    version: "9.9.9",
  };
}

function provenanceSubject(packageName: string, version: string) {
  const [scope, name] = packageName.split("/");
  return `pkg:npm/${encodeURIComponent(scope)}/${name}@${version}`;
}

export function registryFixture(
  artifact: TestArtifact,
  {
    attestationDocument,
    distOverrides = {},
    observedIntegrity = artifact.integrity,
    tarballBytes = Buffer.from("validated tarball bytes"),
  }: {
    attestationDocument?: unknown;
    distOverrides?: Record<string, unknown>;
    observedIntegrity?: string;
    tarballBytes?: Buffer;
  } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyid = "SHA256:test-key";
  const signature = sign(
    "sha256",
    Buffer.from(`${artifact.name}@${artifact.version}:${artifact.integrity}`, "utf8"),
    privateKey,
  ).toString("base64");
  const attestationUrl =
    "https://registry.npmjs.org/-/npm/v1/attestations/@openclaw%2ffs-safe@9.9.9";
  const statement = {
    subject: [
      {
        name: provenanceSubject(artifact.name, artifact.version),
        digest: {
          sha512: Buffer.from(artifact.integrity.slice("sha512-".length), "base64").toString("hex"),
        },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/openclaw/fs-safe",
            path: ".github/workflows/release.yml",
            ref: `refs/tags/v${artifact.version}`,
          },
        },
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  const bundle = {
    dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") },
  };
  const versionDocument = {
    name: artifact.name,
    version: artifact.version,
    dist: {
      integrity: observedIntegrity,
      tarball: registryTarballUrl(artifact.name, artifact.version),
      signatures: [{ keyid, sig: signature }],
      attestations: {
        url: attestationUrl,
        provenance: { predicateType: NPM_PROVENANCE_PREDICATE_TYPE },
      },
      ...distOverrides,
    },
  };
  const keysDocument = {
    keys: [
      {
        keyid,
        key: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      },
    ],
  };
  const resolvedAttestationDocument = attestationDocument ?? {
    attestations: [{ predicateType: NPM_PROVENANCE_PREDICATE_TYPE, bundle }],
  };
  const bodies = new Map<string, BodyInit>([
    [registryVersionUrl(artifact.name, artifact.version), JSON.stringify(versionDocument)],
    ["https://registry.npmjs.org/-/npm/v1/keys", JSON.stringify(keysDocument)],
    [attestationUrl, JSON.stringify(resolvedAttestationDocument)],
    [registryTarballUrl(artifact.name, artifact.version), tarballBytes],
  ]);
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = bodies.get(url);
    if (body === undefined) return new Response("missing", { status: 404 });
    const length = typeof body === "string" ? Buffer.byteLength(body) : (body as Buffer).byteLength;
    return new Response(body, {
      headers: { "content-length": String(length) },
      status: 200,
    });
  });
  return { attestationUrl, bundle, fetchImpl, verifyBundle: vi.fn(async () => undefined) };
}
