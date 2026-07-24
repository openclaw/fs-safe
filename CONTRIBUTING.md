# Contributing to @openclaw/fs-safe

Thanks for helping improve the filesystem safety primitives used by OpenClaw
and other Node.js applications.

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as
described in [SECURITY.md](SECURITY.md).

## Before You Start

- Bugs and small fixes can go directly to a focused pull request.
- Discuss breaking API changes or new security-policy behavior in an issue
  before implementation.
- Search existing issues and pull requests before opening a duplicate.

## Development Setup

Use the Node.js and pnpm versions declared by the repository.

```bash
pnpm install --frozen-lockfile
pnpm check
```

Use the smallest relevant command while iterating:

```bash
pnpm build
pnpm test
pnpm test:security
pnpm pack:check
```

The complete development and documentation guide lives at
[`docs/contributing.md`](docs/contributing.md).

## Pull Requests

- Keep one logical change per pull request.
- Use a conventional title such as
  `fix(root): reject replaced parent directory`.
- Explain the problem, chosen solution, and security or compatibility impact.
- Add focused regression tests for behavior changes.
- Update docs and exports together for new public APIs.
- Update `CHANGELOG.md` for public, security, compatibility, package, or
  operational changes.
- Run `pnpm check` and report the exact validation performed.

Path handling, filesystem identity, exported types, error codes, option
defaults, and package subpaths are public compatibility surfaces. Prefer
additive changes and call out deliberate breaks explicitly.

## Reporting Bugs

Use the bug report template and include:

- the exact package version or commit
- Node.js version, operating system, and filesystem type
- a minimal reproduction
- expected and actual behavior
- relevant redacted logs or filesystem observations

Never include credentials, private hostnames, personal paths, or sensitive file
contents.

## Release Process

Maintainers publish from a protected `vX.Y.Z` tag on `main` through the trusted
publishing workflow. The tag, package version, and dated `CHANGELOG.md` section
must match. Do not publish locally or add an npm automation token.
