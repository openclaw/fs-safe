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

Runs TypeScript compilation and builds the portable Rust TAR parser for
`wasm32-unknown-unknown`. Contributors need Rust (the native crate's declared
minimum or newer) and `rustup target add wasm32-unknown-unknown`; Alpine's
packaged toolchain uses `rust-wasm`. `pnpm archive:wasm` rebuilds just the parser.
The import-free asset lands at `dist/archive-parser.wasm`; source tests and
compiled consumers both resolve that generated artifact. Run `pnpm build`
before source tests in a fresh checkout. Do not commit `dist/` or built WASM.
Consumers receive the asset in the npm package and need no compiler.

Output lands in `dist/`. The package's `prepack` hook re-runs the build before publishing — manual `pnpm build` is only required when you want to inspect the output or run a freshly-built copy locally.

## Test

```bash
pnpm test
```

Vitest. Tests live in `test/` and follow `*.test.ts`. Run a single file with:

```bash
pnpm test test/archive.test.ts
```

Use `vi.mock` sparingly. Most tests should drive real disk operations in a `mkdtemp`-created scratch directory, asserting on observable behavior. The library has [test hooks](testing.md) for the rare cases where you need to inject a TOCTOU race deterministically.

Vitest timeouts do not cancel filesystem promises. Shared fixtures with expensive
setup use `useSuiteFixture` from `test/helpers/suite-fixture.ts`: setup has a separate
30-second hook budget, and teardown waits for tracked setup and test work before
removing directories. Run shared-state corpora sequentially with a deadline per
payload. Keep child-process liveness limits separate from fixture preparation.
The Windows CI slow-copy proof runs the real package-copy process-exit test with a
six-second copy delay, retaining its four-second child deadline:

```bash
pnpm build
pnpm test --config scripts/slow-package-copy.config.ts
```

## Checks

Run the complete repository gate before handoff:

```bash
pnpm check
```

This runs the filesystem boundary checks, build, tests, and package
tarball/import validation.

### Real TAR producers

After installing the freshly packed root (and optionally its freshly built host
binding) in a disposable consumer, run:

```bash
pnpm archive:producer-smoke ./consumer off
pnpm archive:producer-smoke ./consumer require
```

This uses a child bound to canonical cwd/device/inode running `/usr/bin/tar -czf - .`
with unchanged stdout, and npm tar, on synthetic Unicode/newline/long-name files,
then the installed package API for exact payload hashes and bounded reads.
It also rejects a valid PAX override attached to an invalid raw UTF-8 field.
The `require` command must resolve the freshly packed native binding; the
`off` command uses the installed WASM asset. No live user files are read.

### Native consumer installs

The CI Node 24 and native jobs also run `node scripts/device-path-proof.mjs off`
and `node scripts/device-path-proof.mjs require` against the built package.
This extracts real ZIP files and checks bounded member reads, preserving reserved
device-like names on POSIX while rejecting them and ignored-space aliases on
Windows. It also verifies ordinary secret reads and typed device-path rejection
without replacing filesystem functions. Run after `pnpm build`, and build the
host binding with `pnpm native:build` before the `require` case.

After `pnpm build` and a fresh `pnpm native:build`, run `pnpm package:smoke`.
It packs the real root and host binding, then runs root-only npm and the
declared pnpm version against a disposable loopback registry. The root's exact
optional dependencies stay unchanged. Each consumer lives outside the workspace
with isolated configuration, caches, and stores; the registry never proxies to
the Internet. The smoke verifies root integrity, consumer-local resolution,
OS/CPU/libc selection, a native-required SHA-256 operation, and fresh-process
`auto`/`off` fallbacks and `require` failures for missing bindings and omitted
optionals. Omitted-optionals installs also verify that all public subpaths can
be imported, without implying every operation remains available.

Host-only smoke supplies the six foreign packages using their unchanged real
manifests and clearly marked synthetic, non-executable payloads. Every foreign
metadata/tarball endpoint is checked before installation, so a missing fixture
cannot masquerade as successful platform filtering. These temporary fixtures
never enter `packages/`, release artifacts, or the publish manifest. They prove
installer filtering, not foreign native compilation or execution. Full release
collection uses the actual seven collected native tarballs instead. Run it with
`pnpm package:collect` after assembling all seven real bindings; missing targets
fail collection. `pnpm package:collect --allow-host-only` exercises the same
lifecycle boundary locally but proves only the host. Both collection commands
require the pnpm lifecycle CLI path; direct `node` invocation is unsupported. Archive
codecs and their dependencies are packed from the installed dependency graph.

PR CI builds and executes four host targets: Linux x64 glibc, Linux x64 musl
(Alpine), macOS arm64, and Windows x64. The root-only smoke runs on each. The
seven-target source build matrix runs on release tags; packaging all seven is
not execution proof for every architecture. The smoke writes manager versions,
cases, and synthetic-fixture scope to `release-artifacts/consumer-proof.json`.

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
dated `CHANGELOG.md` section to match the tag. It builds and publishes all seven
platform packages before publishing `@openclaw/fs-safe`, verifies every registry
artifact and provenance statement, and then creates the GitHub release.

Each package needs its own npm trusted-publisher configuration for
`openclaw/fs-safe` and `release.yml`. A new platform package must be created and
configured on npm before the first tag that references it; npm trust is
package-specific and cannot be bootstrapped by the tag workflow itself.

External contributors do not need to do anything beyond getting the pull
request merged. Maintainers must not publish locally or add npm automation
tokens.

## Reporting security issues

Suspected security issues belong in private disclosure first. See [`SECURITY.md`](https://github.com/openclaw/fs-safe/blob/main/SECURITY.md) in the repo for the current contact path. Don't open a public issue for a credential-stealing or sandbox-escape bug — coordinate the disclosure first.

## License

By contributing you agree that your contributions are licensed under the project's [MIT license](https://github.com/openclaw/fs-safe/blob/main/LICENSE).
