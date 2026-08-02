import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { verify as verifySigstoreBundle } from "sigstore";

export const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
export const NPM_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
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

const NPM_PROVENANCE_REPOSITORY = "https://github.com/openclaw/fs-safe";
const NPM_PROVENANCE_WORKFLOW_PATH = ".github/workflows/release.yml";
const NPM_PROVENANCE_CERTIFICATE_ISSUER = "https://token.actions.githubusercontent.com";
const NPM_PROVENANCE_BUILDER_ID = "https://github.com/actions/runner/github-hosted";
const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;
const REGISTRY_JSON_MAX_BYTES = 4 * 1024 * 1024;
const REGISTRY_TARBALL_MAX_BYTES = 128 * 1024 * 1024;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;

export class RegistryVerificationError extends Error {
  constructor(message, { code, retryable, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RegistryVerificationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class RetryableRegistryError extends RegistryVerificationError {
  constructor(message, { code, cause } = {}) {
    super(message, { code, retryable: true, cause });
    this.name = "RetryableRegistryError";
  }
}

export class FatalRegistryError extends RegistryVerificationError {
  constructor(message, { code, cause } = {}) {
    super(message, { code, retryable: false, cause });
    this.name = "FatalRegistryError";
  }
}

export function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function requireArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") {
    throw new FatalRegistryError("release artifact metadata is missing", { code: "invalid-artifact" });
  }
  if (!PACKAGE_NAME_PATTERN.test(artifact.name ?? "")) {
    throw new FatalRegistryError(`release artifact has invalid package name: ${String(artifact.name)}`, {
      code: "invalid-artifact",
    });
  }
  if (!PACKAGE_VERSION_PATTERN.test(artifact.version ?? "")) {
    throw new FatalRegistryError(
      `${artifact.name} release artifact has invalid version: ${String(artifact.version)}`,
      { code: "invalid-artifact" },
    );
  }
  if (!SHA512_INTEGRITY_PATTERN.test(artifact.integrity ?? "")) {
    throw new FatalRegistryError(
      `${artifact.name}@${artifact.version} release artifact has invalid sha512 integrity`,
      { code: "invalid-artifact" },
    );
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > REGISTRY_TARBALL_MAX_BYTES) {
    throw new FatalRegistryError(
      `${artifact.name}@${artifact.version} release artifact has invalid size`,
      { code: "invalid-artifact" },
    );
  }
}

function registryRoot() {
  return new URL(`${NPM_REGISTRY_ORIGIN}/`);
}

export function registryVersionUrl(packageName, version) {
  return new URL(`${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, registryRoot()).toString();
}

export function registryTarballUrl(packageName, version) {
  const basename = packageName.includes("/") ? packageName.slice(packageName.lastIndexOf("/") + 1) : packageName;
  return new URL(`${packageName}/-/${basename}-${version}.tgz`, registryRoot()).toString();
}

function registryKeysUrl() {
  return new URL("-/npm/v1/keys", registryRoot()).toString();
}

function trustedRegistryUrl(value, { label, pathPrefix } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new FatalRegistryError(`${label} is not a valid URL`, {
      code: "untrusted-registry-url",
      cause: error,
    });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== NPM_REGISTRY_ORIGIN ||
    (pathPrefix !== undefined && !parsed.pathname.startsWith(pathPrefix))
  ) {
    throw new FatalRegistryError(`${label} is outside the pinned npm registry origin`, {
      code: "untrusted-registry-url",
    });
  }
  return parsed;
}

function isRetryableStatus(status) {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function looksLikeTransientNetworkError(error) {
  const detail = `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)} ${
    error?.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : ""
  }`;
  return /TUFError|aborted|ECONNRESET|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket|timed out/iu.test(
    detail,
  );
}

async function cancelResponse(response) {
  await response.body?.cancel().catch(() => undefined);
}

async function fetchResponse(url, { accept, fetchImpl, label, timeoutMs }) {
  trustedRegistryUrl(url, { label });
  let response;
  try {
    response = await fetchImpl(url, {
      headers: accept ? { accept } : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = `${error instanceof Error ? error.message : String(error)} ${
      error?.cause instanceof Error ? error.cause.message : ""
    }`;
    if (/redirect/iu.test(detail)) {
      throw new FatalRegistryError(`${label} attempted a redirect`, {
        code: "registry-redirect",
        cause: error,
      });
    }
    throw new RetryableRegistryError(`${label} request failed: ${detail.trim()}`, {
      code: "registry-request",
      cause: error,
    });
  }
  if (isRetryableStatus(response.status)) {
    await cancelResponse(response);
    throw new RetryableRegistryError(`${label} returned HTTP ${response.status}`, {
      code: response.status === 404 ? "not-found" : "registry-http",
    });
  }
  if (!response.ok) {
    await cancelResponse(response);
    throw new FatalRegistryError(`${label} returned HTTP ${response.status}`, {
      code: "registry-http",
    });
  }
  return response;
}

async function readBoundedBytes(response, { label, maximumBytes }) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      await cancelResponse(response);
      throw new FatalRegistryError(`${label} exceeds ${maximumBytes} bytes`, {
        code: "registry-body-too-large",
      });
    }
  }
  if (!response.body) {
    throw new RetryableRegistryError(`${label} returned no body`, { code: "registry-body" });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new FatalRegistryError(`${label} exceeds ${maximumBytes} bytes`, {
          code: "registry-body-too-large",
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RegistryVerificationError) throw error;
    throw new RetryableRegistryError(`${label} body read failed`, {
      code: "registry-body",
      cause: error,
    });
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

async function fetchJson(url, options) {
  const response = await fetchResponse(url, { ...options, accept: "application/json" });
  const bytes = await readBoundedBytes(response, {
    label: options.label,
    maximumBytes: REGISTRY_JSON_MAX_BYTES,
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new RetryableRegistryError(`${options.label} returned invalid JSON`, {
      code: "registry-json",
      cause: error,
    });
  }
}

function expectedProvenanceSubject(packageName, version) {
  if (!packageName.startsWith("@")) return `pkg:npm/${packageName}@${version}`;
  const [scope, name] = packageName.split("/");
  return `pkg:npm/${encodeURIComponent(scope)}/${name}@${version}`;
}

export function verifyNpmRegistrySignatures({ integrity, keys, packageName, signatures, version }) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new RetryableRegistryError(`npm registry signatures are missing for ${packageName}@${version}`, {
      code: "incomplete-signatures",
    });
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new RetryableRegistryError("npm registry signing keys are missing", {
      code: "incomplete-signing-keys",
    });
  }
  const payload = `${packageName}@${version}:${integrity}`;
  for (const signature of signatures) {
    const key = keys.find((candidate) => candidate?.keyid === signature?.keyid);
    if (!key || typeof key.key !== "string" || typeof signature.sig !== "string") continue;
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key.key, "base64"),
        format: "der",
        type: "spki",
      });
      if (
        verifySignature(
          "sha256",
          Buffer.from(payload, "utf8"),
          publicKey,
          Buffer.from(signature.sig, "base64"),
        )
      ) {
        return signature.keyid;
      }
    } catch {
      // Try every advertised signature before returning the fatal verdict.
    }
  }
  throw new FatalRegistryError(`npm registry signatures did not verify for ${packageName}@${version}`, {
    code: "invalid-registry-signature",
  });
}

function provenancePolicy(statement, version) {
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const expectedRef = `refs/tags/v${version}`;
  if (
    workflow?.repository !== NPM_PROVENANCE_REPOSITORY ||
    workflow?.path !== NPM_PROVENANCE_WORKFLOW_PATH ||
    workflow?.ref !== expectedRef ||
    statement.predicate?.runDetails?.builder?.id !== NPM_PROVENANCE_BUILDER_ID
  ) {
    throw new FatalRegistryError(
      `npm provenance does not bind ${version} to the trusted fs-safe release workflow`,
      { code: "untrusted-provenance-policy" },
    );
  }
  return {
    certificateIssuer: NPM_PROVENANCE_CERTIFICATE_ISSUER,
    certificateIdentityURI: `${NPM_PROVENANCE_REPOSITORY}/${NPM_PROVENANCE_WORKFLOW_PATH}@${expectedRef}`,
  };
}

export async function verifyNpmProvenanceAttestation({
  attestations,
  integrity,
  packageName,
  verifyBundle = verifySigstoreBundle,
  version,
}) {
  const expectedSubject = expectedProvenanceSubject(packageName, version);
  const expectedSha512 = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  let matchingSubject = false;
  for (const attestation of attestations) {
    if (attestation?.predicateType !== NPM_PROVENANCE_PREDICATE_TYPE) continue;
    const payload = attestation.bundle?.dsseEnvelope?.payload;
    if (typeof payload !== "string") continue;
    let statement;
    try {
      statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      continue;
    }
    if (
      !statement.subject?.some(
        (subject) => subject?.name === expectedSubject && subject?.digest?.sha512 === expectedSha512,
      )
    ) {
      continue;
    }
    matchingSubject = true;
    const policy = provenancePolicy(statement, version);
    try {
      await verifyBundle(attestation.bundle, policy);
      return { policy, subject: expectedSubject };
    } catch (error) {
      if (looksLikeTransientNetworkError(error)) {
        throw new RetryableRegistryError(
          `npm provenance verification was temporarily unavailable for ${packageName}@${version}`,
          { code: "provenance-network", cause: error },
        );
      }
      throw new FatalRegistryError(
        `npm provenance attestation failed Sigstore verification for ${packageName}@${version}`,
        { code: "invalid-sigstore-bundle", cause: error },
      );
    }
  }
  throw new RetryableRegistryError(
    matchingSubject
      ? `npm provenance verification is incomplete for ${packageName}@${version}`
      : `npm provenance attestation does not match ${packageName}@${version} and its artifact digest`,
    { code: "incomplete-provenance" },
  );
}

async function verifyTarballBytes(artifact, { fetchImpl, timeoutMs }) {
  const tarballUrl = registryTarballUrl(artifact.name, artifact.version);
  const response = await fetchResponse(tarballUrl, {
    fetchImpl,
    label: `${artifact.name}@${artifact.version} canonical tarball`,
    timeoutMs,
  });
  const bytes = await readBoundedBytes(response, {
    label: `${artifact.name}@${artifact.version} canonical tarball`,
    maximumBytes: REGISTRY_TARBALL_MAX_BYTES,
  });
  if (bytes.length !== artifact.size) {
    throw new FatalRegistryError(
      `${artifact.name}@${artifact.version} canonical tarball size mismatch: expected ${artifact.size}, found ${bytes.length}`,
      { code: "tarball-size-mismatch" },
    );
  }
  const integrity = sha512Integrity(bytes);
  if (integrity !== artifact.integrity) {
    throw new FatalRegistryError(
      `${artifact.name}@${artifact.version} canonical tarball integrity mismatch: expected ${artifact.integrity}, found ${integrity}`,
      { code: "tarball-integrity-mismatch" },
    );
  }
  return tarballUrl;
}

export async function verifyPublishedPackageOnce(
  artifact,
  {
    fetchImpl = fetch,
    log = console.log,
    timeoutMs = REGISTRY_REQUEST_TIMEOUT_MS,
    verifyBundle = verifySigstoreBundle,
  } = {},
) {
  requireArtifact(artifact);
  const spec = `${artifact.name}@${artifact.version}`;
  let packageDocument;
  try {
    packageDocument = await fetchJson(registryVersionUrl(artifact.name, artifact.version), {
      fetchImpl,
      label: `${spec} version metadata`,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof RetryableRegistryError && error.code === "not-found") {
      error.code = "version-missing";
    }
    throw error;
  }
  if (packageDocument?.name !== artifact.name || packageDocument?.version !== artifact.version) {
    throw new FatalRegistryError(`${spec} registry metadata has the wrong package identity`, {
      code: "registry-identity-mismatch",
    });
  }
  const dist = packageDocument.dist;
  if (!dist || typeof dist !== "object") {
    throw new RetryableRegistryError(`${spec} registry distribution metadata is incomplete`, {
      code: "incomplete-dist",
    });
  }
  const canonicalTarball = registryTarballUrl(artifact.name, artifact.version);
  if (typeof dist.tarball !== "string" || dist.tarball.length === 0) {
    throw new RetryableRegistryError(`${spec} registry tarball metadata is incomplete`, {
      code: "incomplete-dist",
    });
  }
  const advertisedTarball = trustedRegistryUrl(dist.tarball, { label: `${spec} tarball URL` }).toString();
  if (advertisedTarball !== canonicalTarball) {
    throw new FatalRegistryError(`${spec} registry advertised a non-canonical tarball URL`, {
      code: "untrusted-registry-url",
    });
  }

  let byteEvidence = "packument-integrity";
  if (dist.integrity !== artifact.integrity) {
    log(
      `registry metadata integrity conflict for ${spec}: expected ${artifact.integrity}, observed ${String(
        dist.integrity,
      )}; verifying canonical tarball bytes`,
    );
    await verifyTarballBytes(artifact, { fetchImpl, timeoutMs });
    byteEvidence = "canonical-tarball";
  }

  const signatures = dist.signatures;
  const keysDocument = await fetchJson(registryKeysUrl(), {
    fetchImpl,
    label: "npm registry signing keys",
    timeoutMs,
  });
  const signatureKeyId = verifyNpmRegistrySignatures({
    integrity: artifact.integrity,
    keys: keysDocument?.keys,
    packageName: artifact.name,
    signatures,
    version: artifact.version,
  });

  const provenance = dist.attestations?.provenance;
  const attestationUrl = dist.attestations?.url;
  if (
    provenance?.predicateType !== NPM_PROVENANCE_PREDICATE_TYPE ||
    typeof attestationUrl !== "string" ||
    attestationUrl.length === 0
  ) {
    throw new RetryableRegistryError(`npm provenance metadata is incomplete for ${spec}`, {
      code: "incomplete-provenance",
    });
  }
  const attestationPathPrefix = new URL("-/npm/v1/attestations/", registryRoot()).pathname;
  const parsedAttestationUrl = trustedRegistryUrl(attestationUrl, {
    label: `${spec} provenance attestation URL`,
    pathPrefix: attestationPathPrefix,
  });
  const attestationDocument = await fetchJson(parsedAttestationUrl.toString(), {
    fetchImpl,
    label: `${spec} provenance attestation`,
    timeoutMs,
  });
  const attestations = attestationDocument?.attestations;
  if (!Array.isArray(attestations) || attestations.length === 0) {
    throw new RetryableRegistryError(`npm provenance attestations are incomplete for ${spec}`, {
      code: "incomplete-provenance",
    });
  }
  const verifiedProvenance = await verifyNpmProvenanceAttestation({
    attestations,
    integrity: artifact.integrity,
    packageName: artifact.name,
    verifyBundle,
    version: artifact.version,
  });
  return {
    attestationUrl: parsedAttestationUrl.toString(),
    byteEvidence,
    integrity: artifact.integrity,
    observedIntegrity: dist.integrity,
    provenanceSubject: verifiedProvenance.subject,
    signatureKeyId,
    spec,
    tarballUrl: canonicalTarball,
  };
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function isRetryableRegistryError(error) {
  return error instanceof RegistryVerificationError && error.retryable === true;
}

export async function verifyPublishedPackage(
  artifact,
  {
    fetchImpl = fetch,
    log = console.log,
    onVersionMissing,
    retryDelaysMs = REGISTRY_RETRY_DELAYS_MS,
    timeoutMs = REGISTRY_REQUEST_TIMEOUT_MS,
    verifyBundle = verifySigstoreBundle,
    wait = sleep,
  } = {},
) {
  let missingHandled = false;
  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await verifyPublishedPackageOnce(artifact, { fetchImpl, log, timeoutMs, verifyBundle });
    } catch (error) {
      lastError = error;
      if (!isRetryableRegistryError(error)) throw error;
      if (error.code === "version-missing" && !missingHandled && onVersionMissing) {
        missingHandled = true;
        await onVersionMissing();
      }
      if (attempt === retryDelaysMs.length) break;
      const delayMs = retryDelaysMs[attempt];
      log(
        `registry verification attempt ${attempt + 1}/${retryDelaysMs.length + 1} has not confirmed ${
          artifact.name
        }@${artifact.version} (${error.message}); retrying in ${delayMs / 1_000}s`,
      );
      await wait(delayMs);
    }
  }
  throw new Error(
    `registry verification exhausted ${retryDelaysMs.length + 1} attempts for ${artifact.name}@${
      artifact.version
    }: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}
