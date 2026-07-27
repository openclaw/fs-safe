# 0.5.0 release prerequisites

Complete this checklist in npm before pushing the first `v0.5.0` tag. The release workflow uses npm trusted publishing and has no npm token fallback.

## Package setup

Exactly one package is published: `@openclaw/fs-safe`. It already exists, is public, and is owned by the OpenClaw npm organization.

Open its npm package settings and configure this trusted publisher:

| npm trusted-publisher field | Required value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `openclaw` |
| Repository | `fs-safe` |
| Workflow filename | `release.yml` |
| Environment | Leave empty; this workflow does not use a GitHub environment. |

Confirm the publishing maintainers have 2FA enabled. Do not add `NPM_TOKEN` or an automation token to GitHub. The former native loader and platform package names were never published, so there is nothing to deprecate or unpublish.

## Release commit and tag

- Confirm `0.5.0` in the root package, private native build workspace, and Rust crate.
- Run `pnpm install` so `pnpm-lock.yaml` matches the stable package version.
- Change `## 0.5.0 - Unreleased` in `CHANGELOG.md` to the release date.
- Run `pnpm check`, `pnpm test:security`, `cargo test --workspace --locked`, `cargo clippy --workspace --locked -- -D warnings`, `pnpm docs:site`, and `git diff --check` on the release commit.
- Merge the release commit to `main`, then create an annotated, protected `v0.5.0` tag on that exact commit.

The workflow validates the protected annotated tag, `main` ancestry, package and crate versions, all seven non-empty native binaries, the single tarball's bytes, install/import behavior, native loading and fallback behavior, and changelog-derived release notes before it publishes anything.
