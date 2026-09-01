# Release prerequisites

Maintainer checklist for the protected, tag-driven [release workflow](.github/workflows/release.yml). See [the contribution guide](docs/contributing.md) for development and validation details. Publishing uses npm trusted publishing, with no npm token fallback or local publication.

## Package setup

A release publishes eight packages:

- `@openclaw/fs-safe`: JavaScript, declarations, and documentation; no embedded native binaries.
- `@openclaw/fs-safe-darwin-arm64`
- `@openclaw/fs-safe-darwin-x64`
- `@openclaw/fs-safe-linux-arm64-gnu`
- `@openclaw/fs-safe-linux-arm64-musl`
- `@openclaw/fs-safe-linux-x64-gnu`
- `@openclaw/fs-safe-linux-x64-musl`
- `@openclaw/fs-safe-win32-x64-msvc`

The `native/` npm workspace and Rust crate are private build inputs, not additional published packages. The seven native packages are platform-filtered optional dependencies of the root package.

Each published package must have this trusted publisher configured in npm:

| npm trusted-publisher field | Required value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `openclaw` |
| Repository | `fs-safe` |
| Workflow filename | `release.yml` |
| Environment | Leave empty; the workflow does not use a GitHub environment. |

Use the existing package and publisher configuration; do not bootstrap or reconfigure it merely to retry a release. Publishing maintainers must have 2FA enabled. Do not add `NPM_TOKEN` or an automation token to GitHub.

## Prepare the release candidate

Update the root package version, all seven native package versions, all seven exact root optional-dependency pins, the private native npm workspace version, and the crate version in `native/Cargo.toml`. The root `Cargo.toml` is an unversioned workspace.

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

Host-native package proof additionally uses `pnpm native:build` followed by `pnpm package:smoke`. Its synthetic foreign-platform filtering fixtures are not foreign runtime proof. Full `pnpm package:collect` requires all seven real bindings assembled by the release workflow and must run through pnpm.

Do not commit generated `dist/` files, native binaries, or release artifacts.

## Tag and publish

Merge the reviewed release preparation into `main` after its exact-head CI is green. Confirm the intended release commit is the requested latest main before creating an annotated, protected `vX.Y.Z` tag on that exact commit. Push only that tag; never move or overwrite an existing release tag.

The workflow checks tag format, annotation, protection, main ancestry, matching package/crate versions and pins, and dated changelog content. Main ancestry alone does not guarantee the tag points to latest main, and the workflow does not wait for a separate CI run; maintainers must enforce both conditions before tagging.

The automated order is source validation, seven-target native build, assembly and eight-package smoke validation, draft GitHub Release creation, platform-package publication, root-package publication, cryptographic registry verification, release-note proof generation, and draft promotion. A tag push alone is not a completed release.

If a version already exists, the publishing helper verifies it instead of republishing it. Preserve the collected manifest and tarballs when investigating a failure. Never rebuild or replace published artifacts to work around a byte, signature, or provenance mismatch.

## Verify the completed release

For the root and all seven native packages, verify the exact version, expected `latest` dist-tag, canonical registry tarball URL, integrity, publication time, registry signatures, and workflow-bound provenance. Confirm the public GitHub Release and protected annotated tag exist and point to the intended commit.

The Release body must match the finalized changelog and include npm version links, registry tarball links, integrity, attestation proof, and the successful Actions run. Download the workflow's collected package artifacts promptly; their retention is bounded.

Leave the repository clean on synchronized `main`. Do not prefill another release or create the next Unreleased section as part of closeout.
