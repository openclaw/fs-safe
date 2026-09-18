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

Runs TypeScript compilation and builds the portable Rust TAR parser and its
bzip2/zstd codecs for `wasm32-unknown-unknown`. Contributors need Rust (the
native crate's declared minimum or newer), `rustup target add
wasm32-unknown-unknown`, and LLVM's WebAssembly-capable `clang` and `llvm-ar`.
The system's native `ar` is not sufficient. `pnpm archive:wasm` rebuilds just
the portable module.

Linux, macOS, and Windows CI use the same pinned WASI SDK 27 LLVM toolchain;
Alpine uses its versioned LLVM 20 packages alongside `rust-wasm`. For local
builds, install LLVM through your package manager or use the official
[WASI SDK](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-27).
On macOS, `brew install llvm` supplies the archiver missing from Apple's
Command Line Tools. On Windows, install the LLVM distribution with both
`clang.exe` and `llvm-ar.exe`. On Linux, install the matching `clang` and
`llvm` packages; a GCC-only build toolchain cannot compile these WASM codecs.

The build discovers tools on `PATH`, in `LLVM_PATH/bin`, in Homebrew's LLVM
prefixes, and in Windows' standard LLVM installation. It also checks the
versioned `clang-18` through `clang-21` and `llvm-ar-18` through `llvm-ar-21`
executables. To select another installation explicitly, set
`CC_wasm32_unknown_unknown` and `AR_wasm32_unknown_unknown` to its compiler
and archiver. The corresponding hyphenated target variables and cc-rs's
`TARGET_CC`/`TARGET_AR` or `CC`/`AR` overrides are also respected; an unusable
explicit override fails with a builder diagnostic instead of being ignored.
Clang's implicit configuration is disabled for this target so the WASI SDK's
default libc/sysroot cannot leak into the import-free module. These settings
affect compilation only and do not become runtime dependencies.

The build disables release LTO only in the WASM Cargo subprocess. An observed
Rust 1.98.1 optimized-WASM-LTO allocation/free failure makes that necessary;
the native release profile stays unchanged. The WASM linker strips debug
sections to keep the bundled module small without stripping native binaries.
The build verifies zero host
imports and one unshared 32-bit memory with the existing 256 MiB maximum
before copying the artifact. Allocator regression tests build a separate
instrumented module with `pnpm archive:wasm:allocator-tests` under the Cargo
target directory. That module is never copied to `dist/` or packaged. `pnpm
check` and coverage collection build it explicitly before testing. After a
fresh checkout, run that command before `pnpm test`, `pnpm test:coverage`, or
focused `test/archive-codec-wasm-allocator.test.ts` runs; the tests fail if
their prerequisite artifact is missing.

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

Guest filesystem tests and package smoke also need `python3` on Linux and
macOS. They execute the exported source on synthetic files; Windows checks
the import surface and leaves POSIX execution to the Linux/macOS lanes.
After building on Linux, `node scripts/check-pack.mjs --guest-cross-device`
also proves an installed-package directory move from temporary storage to
`/dev/shm`; the command requires those locations to be different filesystems.

With Bun 1.4.2 installed, build the host addon and run the native compatibility
lane in real Bun workers, then exercise the built package with JIT disabled:

```bash
pnpm native:build
pnpm test:bun:native
bun --jitless scripts/bun-native-proof.mjs
```

Keep the Node/pnpm build toolchain above. CI runs the native compatibility lane
on Linux, macOS, and Windows. The built-package proof checks `auto`/`require`,
native-off loading policy, and a separate installation without the addon.

`pnpm test:bun` runs the entire Node-oriented suite as a diagnostic. On released
Bun, its explicit native-off and missing-helper cases include unsupported
permission/path behavior described in [install](install.md#bun-runtime); this
command is not a passing compatibility gate. Node CI retains every fallback
assertion. Neither lane rewrites `off` to `auto` or marks defects as expected passes.

Use `vi.mock` sparingly. Most tests should drive real disk operations in a `mkdtemp`-created scratch directory, asserting on observable behavior. The library has [test hooks](testing.md) for the rare cases where you need to inject a TOCTOU race deterministically.

Vitest timeouts do not cancel filesystem promises. Shared fixtures with expensive
setup use `useSuiteFixture` from `test/helpers/suite-fixture.ts`: setup has a separate
30-second hook budget, and teardown waits for tracked setup and test work before
removing directories. Run shared-state corpora sequentially with a deadline per
payload. Keep child-process liveness limits separate from fixture preparation.
The Windows CI slow-copy proof runs the real package-copy process-exit test with a
16-second copy delay, a 10-second child deadline, a 15-second test deadline, and
60-second setup and teardown hook budgets. Other hosts retain the ordinary
six-second delay, four-second child deadline, five-second test deadline, and
30-second hook budgets:

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

### Method benchmarks

`pnpm benchmark:methods` measures the callable library surface against synthetic
fixtures and fails on uncovered exports or returned methods. See the
[benchmark guide](https://github.com/openclaw/fs-safe/tree/main/benchmarks) for native/fallback runs, per-call
timings, exclusions, and comparison methodology. Run `pnpm build` first.

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
require the pnpm lifecycle CLI path; JavaScript CLIs run through Node and standalone
`@pnpm/exe` binaries run directly. Shell/cmd shims and PATH fallback are not used;
direct `node` invocation without lifecycle metadata is unsupported. Archive
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
