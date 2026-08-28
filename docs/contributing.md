# Contributing

The `fs-safe` repo lives at [github.com/openclaw/fs-safe](https://github.com/openclaw/fs-safe). Contributions welcome — issues, bug reports, focused PRs.

## Local setup

```bash
git clone https://github.com/openclaw/fs-safe.git
cd fs-safe
pnpm install
```

Node 22 or newer. The dev toolchain and lockfile use pnpm; use the package
manager version declared in `package.json`.

## Build

```bash
pnpm build
```

Runs `tsc -p tsconfig.json`. Output lands in `dist/`. The package's `prepack` hook re-runs the build before publishing — manual `pnpm build` is only required when you want to inspect the output or run a freshly-built copy locally.

## Test

```bash
pnpm test
```

Vitest. Tests live in `test/` and follow `*.test.ts`. Run a single file with:

```bash
pnpm test test/archive.test.ts
```

Use `vi.mock` sparingly. Most tests should drive real disk operations in a `mkdtemp`-created scratch directory, asserting on observable behavior. The library has [test hooks](testing.md) for the rare cases where you need to inject a TOCTOU race deterministically.

## Checks

Run the complete repository gate before handoff:

```bash
pnpm check
```

This runs the filesystem boundary checks, build, tests, and package
tarball/import validation.

## Docs

The docs site is rendered recursively from Markdown files under `docs/` by `scripts/build-docs-site.mjs`. Build locally to preview:

```bash
pnpm docs:site
open dist/docs-site/index.html
```

The build validates internal links and embedded anchors. Broken links fail the build — fix them before pushing. Navigation must list every non-excluded Markdown page exactly once: missing, nonexistent, and duplicate entries fail before the build replaces existing site output. The builder and navigation tests share discovery and validation in `scripts/docs-site-navigation.mjs`.

Adding a new doc page:

1. Create `docs/<page>.md`. Use a leading `# Title` heading.
2. Add the page to the appropriate section in `scripts/docs-site-navigation.mjs` (`sections` array near the top). Nested pages use slash-separated paths relative to `docs/`, such as `guides/example.md`.
3. Cross-link from `docs/index.md` if it's a major surface.
4. Run `pnpm test test/docs-site-navigation.test.ts` and re-run the local build.

Internal links use relative `*.md` paths — the builder rewrites them to the rendered HTML. Code fences support GitHub-flavored markdown.

## PRs

Small, focused PRs land faster. The general shape:

- One concern per PR. Bug fixes separate from new APIs.
- A regression test for every bug fix where the test framework can express it.
- A changelog entry under `## Unreleased` when behavior visibly changes.
- For new public APIs: a docs page in `docs/` plus a sidebar entry.

## Releases

Maintainers publish from a protected `vX.Y.Z` tag on `main` through
`.github/workflows/release.yml`. The workflow requires the package version and a
dated `CHANGELOG.md` section to match the tag, then publishes with npm trusted
publishing and provenance before creating the GitHub release.

External contributors do not need to do anything beyond getting the pull
request merged. Maintainers must not publish locally or add npm automation
tokens.

## Reporting security issues

Suspected security issues belong in private disclosure first. See [`SECURITY.md`](https://github.com/openclaw/fs-safe/blob/main/SECURITY.md) in the repo for the current contact path. Don't open a public issue for a credential-stealing or sandbox-escape bug — coordinate the disclosure first.

## License

By contributing you agree that your contributions are licensed under the project's [MIT license](https://github.com/openclaw/fs-safe/blob/main/LICENSE).
