# AGENTS.md - @openclaw/fs-safe

## Purpose

`@openclaw/fs-safe` provides capability-style filesystem roots and related
primitives for Node.js applications that handle untrusted paths.

Filesystem boundaries, identity checks, archive extraction, permissions, and
secret handling are security-sensitive public contracts.

## Repository

- GitHub: `https://github.com/openclaw/fs-safe`
- npm: `https://www.npmjs.com/package/@openclaw/fs-safe`
- Docs: `https://fs-safe.io`
- Default branch: `main`
- Runtime: Node.js `>=22`
- Package manager: `pnpm`; use the version declared in `package.json`
- Human contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)

`CLAUDE.md` is a compatibility symlink to this file. Edit `AGENTS.md` only.
Shared maintainer skills live in `openclaw/agent-skills`; do not vendor copies
into this repository unless a repo-specific snapshot is intentionally required.

## Security Boundaries

- Never weaken root confinement, path normalization, symlink or hardlink
  rejection, post-operation identity checks, or pinned file behavior.
- Treat pathnames as attacker-controlled unless a public API explicitly says
  otherwise.
- Keep unsafe fallback behavior explicit, bounded, and documented.
- Preserve fail-closed behavior for ambiguous filesystem identity and
  ownership states.
- Add focused regression tests for traversal, swap races, archive extraction,
  permissions, secret files, and platform-specific fallbacks.
- Do not add raw filesystem primitives that bypass the shared guarded helpers.

## Public Package Contract

- Keep exports, generated declarations, README examples, and docs aligned.
- Treat exported types, error codes, option defaults, and package subpaths as
  compatibility surfaces.
- Update `CHANGELOG.md` under `Unreleased` for public, security, compatibility,
  package, or operational changes.
- Never commit generated `dist/` output.
- Releases are tag-driven from `main` through
  `.github/workflows/release.yml`; never publish locally or add npm tokens.

## Commands

Use repository scripts rather than invoking underlying tools directly:

```bash
pnpm build
pnpm test
pnpm test:security
pnpm check
pnpm pack:check
```

Run the smallest relevant test while iterating. Run `pnpm check` and
`git diff --check` before handoff.

## Change Rules

- Keep one logical concern per change.
- Use conventional commit and pull request titles.
- Do not edit dependency lockfiles by hand.
- Never commit credentials, private paths, private hosts, or unredacted logs.
- Run the shared `autoreview` skill before shipping non-trivial changes.
