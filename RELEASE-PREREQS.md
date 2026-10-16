# Release prerequisites

Maintainer checklist for the protected, tag-driven [release workflow](.github/workflows/release.yml). See [the contribution guide](docs/contributing.md) for development and validation details. Publishing uses npm trusted publishing, with no npm token fallback or local publication.

## Package setup

A release publishes the root package and every platform package in `scripts/native-targets.mjs`:

- `@openclaw/fs-safe`: JavaScript, declarations, and documentation; no embedded native binaries.
- `@openclaw/fs-safe-darwin-arm64`
- `@openclaw/fs-safe-darwin-x64`
- `@openclaw/fs-safe-linux-arm64-gnu`
- `@openclaw/fs-safe-linux-arm64-musl`
- `@openclaw/fs-safe-linux-x64-gnu`
- `@openclaw/fs-safe-linux-x64-musl`
- `@openclaw/fs-safe-win32-arm64-msvc`
- `@openclaw/fs-safe-win32-x64-msvc`
- `@openclaw/fs-safe-freebsd-x64`
- `@openclaw/fs-safe-freebsd-arm64`

The `native/` npm workspace and Rust crate are private build inputs, not additional published packages. The native packages are platform-filtered optional dependencies of the root package.

Each published package must have this trusted publisher configured in npm:

| npm trusted-publisher field | Required value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `openclaw` |
| Repository | `fs-safe` |
| Workflow filename | `release.yml` |
| Environment | Leave empty; the workflow does not use a GitHub environment. |

Use the existing package and publisher configuration; do not bootstrap or reconfigure it merely to retry a release. Publishing maintainers must have 2FA enabled. Do not add `NPM_TOKEN` or an automation token to GitHub.

## Windows Authenticode signing (one-time maintainer setup)

Release Windows addons (`win32-x64-msvc` and `win32-arm64-msvc`) and the main
package's `dist/windows-security-helper.exe` must pass signing before release
collection or publication. There is no unsigned publication fallback. Only
tag-triggered `release.yml` jobs use this signing environment; dry runs, PRs,
and main-push CI build and test unsigned binaries without
requesting it. npm trusted publishing above remains unchanged and does not use
this environment.

The maintainer completed this setup for PR #960:

1. GitHub environment `release-signing` exists in `openclaw/fs-safe` and mirrors `npm-publish`'s protections: release tag policy `v*.*.*` (type **tag**), required reviewers (`steipete` or `vincentkoc`), and prevention of self-review. There is no standing branch exception.
2. Environment secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` are configured for the dedicated Azure app registration `openclaw-fs-safe-signing`, appId `d151e936-0326-4a9d-81b7-9fcc0850a795`.
3. The app has a federated identity credential with issuer `https://token.actions.githubusercontent.com`, subject `repo:openclaw/fs-safe:environment:release-signing`, and audience `api://AzureADTokenExchange`.
4. The identity has the **Artifact Signing Certificate Profile Signer** role scoped to the `openclaw` certificate profile. The workflow uses endpoint `https://eus.codesigning.azure.net/`, account `openclaw`, and certificate profile `openclaw`.

Environment, secret, and Azure changes remain maintainer actions; do not change
them as part of a code update. Missing configuration or failed signature
validation stops the release with a pointer to this section. Setup completion
does not substitute for signed runtime proof during a real tag release.

### Release dry run (unsigned, no publication)

Run the current package version from merged `main` without changing environment
policies, creating a tag, or publishing:

```bash
gh workflow run release.yml --repo openclaw/fs-safe --ref main -f dry_run=true
```

Dry runs never request `release-signing`, signing credentials, or OIDC access.
They build every target, compare Ubuntu/Windows helper hashes, and load-test the
unsigned Windows addons and helper on x64 and ARM64. The final dry-run job
assembles all bindings and runs unsigned host-package installation smoke tests;
FreeBSD jobs perform their own package smoke tests. Its `dry-run-package`
artifact contains development packages, not the signed all-platform
`release-package` artifact used for publication. Full signed package collection
and Authenticode verification remain exclusive to protected tag releases.

Every manual dispatch is publication-disabled, even on a release tag.
`dry_run=false` skips the run; it does not enable publication. Inspect both
`Load unsigned Windows binaries` jobs and `Assemble unsigned binaries and smoke
test host packages`. Signing, signed runtime tests, release collection, and all
publication jobs must be skipped. No deployment branch exception is needed.

The helper build targets .NET Framework 4.6.2 (`net462`) and includes
`src/windows-owner-query.cs` alongside the raw security bridge and transport.
Both signed runtime jobs exercise the portable security operations and the
owner/ACL compatibility query against the signed executable.

## Prepare the release candidate

Update the root package version, all native package versions and exact root optional-dependency pins, the private native npm workspace version, and the crate version in `native/Cargo.toml`. The root `Cargo.toml` is an unversioned workspace.

Regenerate the lockfiles rather than editing them by hand:

```bash
pnpm install
```

```bash
cargo update --workspace --offline
```

Inspect both lockfile diffs for unrelated dependency changes. Use the toolchain versions declared in the repository and workflow.

Finalize a nonempty, dated `## X.Y.Z - YYYY-MM-DD` changelog section, including every user-visible change since the preceding release. Generate and inspect its release notes:

```bash
pnpm release:notes X.Y.Z
```

Run the release checks on the candidate:

```bash
pnpm check
```

```bash
pnpm test:security
```

```bash
cargo test --workspace --locked
```

```bash
cargo clippy --workspace --locked -- -D warnings
```

```bash
pnpm docs:site
```

```bash
git diff --check
```

Host-native package proof additionally uses `pnpm native:build` (`pnpm native:build:freebsd` on FreeBSD) followed by `pnpm package:smoke`. Its synthetic foreign-platform filtering fixtures are not foreign runtime proof. Full `pnpm package:collect --windows-signing-manifest <path>` requires every real binding assembled by the release workflow plus its `windows-signing.json` proof, and must run through pnpm. Host-only `pnpm package:smoke` remains unsigned development proof. FreeBSD builds and installed-package smoke run inside 14.4 VMs for x64 and arm64; ARM64 uses QEMU CPU emulation with a real FreeBSD kernel. FreeBSD x64 tests npm and pnpm installs. ARM64 tests npm installs only because pnpm publishes no native executable for that target; CI prepares its proof harness dependencies on Linux, syncs the workspace into the VM, and runs `npm run package:smoke` there.

Do not commit generated `dist/` files, native binaries, or release artifacts.

## Tag and publish

Merge the reviewed release preparation into `main` after its exact-head CI is green. Confirm the intended release commit is the requested latest main before creating an annotated, protected `vX.Y.Z` tag on that exact commit. Push only that tag; never move or overwrite an existing release tag.

The workflow checks tag format, annotation, protection, main ancestry, matching package/crate versions and pins, and dated changelog content. Main ancestry alone does not guarantee the tag points to latest main, and the workflow does not wait for a separate CI run; maintainers must enforce both conditions before tagging.

The automated order is source validation, all-target native and reproducible helper builds, Windows signing and signed runtime tests, assembly and package smoke validation, draft GitHub Release creation, platform-package publication, root-package publication, cryptographic registry verification, release-note proof generation, and draft promotion. A tag push alone is not a completed release.

Package publication and release-proof generation use batches of at most four packages under their unchanged 90-minute job ceilings. Every platform package must finish publication and byte-identity, registry-signature, and provenance verification before root publication starts. A failed batch settles its in-flight operations, then stops without starting another batch or publishing the root. Final release proof retains manifest order and is appended only after every package verifies.

The configured retry sleeps still total 530 seconds per package. With the current eight platform packages plus root, publication and final proof each have three sequential retry schedules (26 minutes 30 seconds). With ten platform packages plus root, publication has `ceil(10 / 4) + 1 = 4` schedules (35 minutes 20 seconds), and final proof has `ceil(11 / 4) = 3` (26 minutes 30 seconds); those bounds also cover eleven platform packages plus root. This leaves at least 54 minutes 40 seconds of nominal non-sleep headroom per job at that size. This is an overall fail-closed cap, not a guarantee that every package can exhaust its retry schedule: each attempt can also make separately bounded registry requests, while npm publication and Sigstore verification have no separate total deadline. Pathologically slow or unbounded external work can still reach the outer ceiling. No verification check or per-package retry schedule is relaxed.

If a version already exists, the publishing helper verifies it instead of republishing it. A retry after timeout reuses the collected manifest and tarballs from successful jobs in the same workflow run. Preserve those artifacts when investigating a failure; never rebuild or replace published artifacts to work around a byte, signature, or provenance mismatch.

## Verify the completed release

For the root and all native packages, verify the exact version, expected `latest` dist-tag, canonical registry tarball URL, integrity, publication time, registry signatures, and workflow-bound provenance. Confirm the public GitHub Release and protected annotated tag exist and point to the intended commit.

The Release body must match the finalized changelog and include npm version links, registry tarball links, integrity, attestation proof, and the successful Actions run. Download the workflow's collected package artifacts promptly; their retention is bounded.

Leave the repository clean on synchronized `main`. Do not prefill another release or create the next Unreleased section as part of closeout.
