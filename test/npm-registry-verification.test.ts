import { describe, expect, it, vi } from "vitest";
import {
  FatalRegistryError,
  RetryableRegistryError,
  isRetryableRegistryError,
  registryTarballUrl,
  registryVersionUrl,
  verifyPublishedPackage,
  verifyPublishedPackageOnce,
} from "../scripts/npm-registry-verification.mjs";
import { registryFixture, testArtifact } from "./npm-registry-fixture.js";

describe("npm registry verification", () => {
  it("verifies registry signatures and provenance against the validated artifact", async () => {
    const artifact = testArtifact();
    const fixture = registryFixture(artifact);

    const proof = await verifyPublishedPackageOnce(artifact, {
      fetchImpl: fixture.fetchImpl,
      verifyBundle: fixture.verifyBundle,
    });

    expect(proof).toMatchObject({
      byteEvidence: "packument-integrity",
      integrity: artifact.integrity,
      observedIntegrity: artifact.integrity,
      provenanceSubject: "pkg:npm/%40openclaw/fs-safe@9.9.9",
      tarballUrl: registryTarballUrl(artifact.name, artifact.version),
    });
    expect(fixture.verifyBundle).toHaveBeenCalledWith(
      fixture.bundle,
      {
        certificateIdentityURI:
          "https://github.com/openclaw/fs-safe/.github/workflows/release.yml@refs/tags/v9.9.9",
        certificateIssuer: "https://token.actions.githubusercontent.com",
      },
    );
    expect(fixture.fetchImpl).not.toHaveBeenCalledWith(
      registryTarballUrl(artifact.name, artifact.version),
      expect.anything(),
    );
  });

  it("accepts canonical tarball bytes when packument integrity conflicts and logs both values", async () => {
    const bytes = Buffer.from("validated tarball bytes");
    const artifact = testArtifact(bytes);
    const fixture = registryFixture(artifact, {
      observedIntegrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      tarballBytes: bytes,
    });
    const log = vi.fn();

    const proof = await verifyPublishedPackageOnce(artifact, {
      fetchImpl: fixture.fetchImpl,
      log,
      verifyBundle: fixture.verifyBundle,
    });

    expect(proof.byteEvidence).toBe("canonical-tarball");
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`expected ${artifact.integrity}, observed sha512-`));
    expect(fixture.fetchImpl).toHaveBeenCalledWith(
      registryTarballUrl(artifact.name, artifact.version),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("fails fatally and without retry when canonical tarball bytes are corrupt", async () => {
    const artifact = testArtifact();
    const fixture = registryFixture(artifact, {
      observedIntegrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      tarballBytes: Buffer.from("corrupt tarball bytes"),
    });
    const wait = vi.fn(async () => undefined);

    await expect(
      verifyPublishedPackage(artifact, {
        fetchImpl: fixture.fetchImpl,
        retryDelaysMs: [1, 2, 3],
        verifyBundle: fixture.verifyBundle,
        wait,
      }),
    ).rejects.toMatchObject({ code: "tarball-size-mismatch", retryable: false });
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails fatally when same-size canonical tarball bytes have a different sha512", async () => {
    const artifact = testArtifact();
    const fixture = registryFixture(artifact, {
      observedIntegrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      tarballBytes: Buffer.from("invalidxx tarball bytes"),
    });

    await expect(
      verifyPublishedPackageOnce(artifact, {
        fetchImpl: fixture.fetchImpl,
        verifyBundle: fixture.verifyBundle,
      }),
    ).rejects.toMatchObject({ code: "tarball-integrity-mismatch", retryable: false });
  });

  it("retries incomplete provenance and reports exhaustion after the configured attempts", async () => {
    const artifact = testArtifact();
    const fixture = registryFixture(artifact, { distOverrides: { attestations: {} } });
    const wait = vi.fn(async () => undefined);

    await expect(
      verifyPublishedPackage(artifact, {
        fetchImpl: fixture.fetchImpl,
        retryDelaysMs: [5, 10],
        verifyBundle: fixture.verifyBundle,
        wait,
      }),
    ).rejects.toThrow("registry verification exhausted 3 attempts");
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([5, 10]);
    expect(
      fixture.fetchImpl.mock.calls.filter(([url]) => String(url) === registryVersionUrl(artifact.name, artifact.version)),
    ).toHaveLength(3);
  });

  it("retries transient Sigstore trust-root network failures", async () => {
    const artifact = testArtifact();
    const fixture = registryFixture(artifact);
    const verifyBundle = vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { name: "TUFError" });
    });
    const wait = vi.fn(async () => undefined);

    await expect(
      verifyPublishedPackage(artifact, {
        fetchImpl: fixture.fetchImpl,
        retryDelaysMs: [5],
        verifyBundle,
        wait,
      }),
    ).rejects.toThrow("registry verification exhausted 2 attempts");
    expect(verifyBundle).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(5);
  });

  it("treats authentication errors, untrusted URLs, signatures, policy, and bytes as fatal", async () => {
    const artifact = testArtifact();
    const forbidden = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(verifyPublishedPackageOnce(artifact, { fetchImpl: forbidden })).rejects.toMatchObject({
      code: "registry-http",
      retryable: false,
    });

    const untrusted = registryFixture(artifact, {
      distOverrides: { tarball: "https://example.test/package.tgz" },
    });
    await expect(
      verifyPublishedPackageOnce(artifact, {
        fetchImpl: untrusted.fetchImpl,
        verifyBundle: untrusted.verifyBundle,
      }),
    ).rejects.toMatchObject({ code: "untrusted-registry-url", retryable: false });

    const badSignature = registryFixture(artifact, {
      distOverrides: { signatures: [{ keyid: "unknown", sig: "invalid" }] },
    });
    await expect(
      verifyPublishedPackageOnce(artifact, {
        fetchImpl: badSignature.fetchImpl,
        verifyBundle: badSignature.verifyBundle,
      }),
    ).rejects.toMatchObject({ code: "invalid-registry-signature", retryable: false });

    const badPolicy = registryFixture(artifact);
    const originalResponse = badPolicy.fetchImpl;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await originalResponse(input, init);
      if (String(input) !== badPolicy.attestationUrl) return response;
      const document = await response.json();
      const statement = JSON.parse(
        Buffer.from(document.attestations[0].bundle.dsseEnvelope.payload, "base64").toString("utf8"),
      );
      statement.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/evil/repo";
      document.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
      return Response.json(document);
    });
    await expect(
      verifyPublishedPackageOnce(artifact, { fetchImpl, verifyBundle: badPolicy.verifyBundle }),
    ).rejects.toMatchObject({ code: "untrusted-provenance-policy", retryable: false });
  });

  it("exposes an explicit retryability taxonomy", () => {
    expect(isRetryableRegistryError(new RetryableRegistryError("pending"))).toBe(true);
    expect(isRetryableRegistryError(new FatalRegistryError("fatal"))).toBe(false);
    expect(isRetryableRegistryError(new Error("unknown"))).toBe(false);
  });
});
