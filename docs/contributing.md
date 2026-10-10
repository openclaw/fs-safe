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

Linux, macOS, and Windows CI use the same pinned WASI SDK 34 LLVM toolchain;
Alpine uses its versioned LLVM 22 packages alongside `rust-wasm`. For local
builds, install LLVM through your package manager or use the official
[WASI SDK](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34).
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
Windows build environment names are case-insensitive, including when worker
processes uppercase them. The build normalizes only its copied child environment.
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

### Linux GNU release bindings

GNU x64 and arm64 artifacts use Zig 0.16.0 and `cargo-zigbuild` 0.23.4 with an
explicit glibc 2.28 target, independent of the runner's libc. This matches the
Node Linux runtime baseline and supports RHEL 8-family users without adding a
second legacy package. Run the same build and ABI gate used in CI and releases:

```bash
cargo install cargo-zigbuild --version 0.23.4 --locked
rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
node scripts/build-linux-gnu.mjs x86_64-unknown-linux-gnu
node scripts/build-linux-gnu.mjs aarch64-unknown-linux-gnu
```

These commands require Zig on `PATH` and GNU `objdump`. They build the N-API
cdylib with `cargo zigbuild --target <triple>.2.28`, copy it to the existing
`artifacts/fs-safe-native.<platform>.node` name, and reject any GLIBC symbol
requirement above 2.28 before upload. The gate also rejects missing or unknown
GLIBC versions. To inspect an existing binding, use
`node scripts/check-linux-glibc.mjs <binding.node>`.

`pnpm native:build` remains a host-toolchain development build; it does not
establish the GNU release ABI floor.

On Linux x64 or arm64 with Docker, run `pnpm build`, copy the matching GNU artifact from
`artifacts/` to `native/`, run `node scripts/stage-host-native.mjs`, then run
`bash scripts/test-linux-glibc-floor.sh`. CI uses this command to load the actual
artifact and run native security and no-replace move tests in Rocky Linux 8
(glibc 2.28). Both GNU architectures execute this load test on matching runners.

### Windows ARM64 builds

`windows-11-arm` builds and runs the ARM64 MSVC addon using native ARM64 Node
and Rust, and separately tests x64 Node and Rust under Windows emulation. Both
lanes run the native suite, main-thread and Worker private-creation/descriptor
proof, and root-only npm/pnpm install smoke. PE inspection matches the loaded
consumer binary's hash, architecture and required NT imports. Omitted-optionals
creation probes in the x64-emulated cell have a 600-second deadline: three
complete measurements had a 183.18-second median, with 140 PowerShell launches
accounting for 98–99% of wall time. This is over three times that median, rounded
up to a whole minute. Native ARM64 and x64 cells, and every other consumer probe,
retain their 120-second deadlines. Release builds
also run the ARM64 native security and Worker tests before uploading the binding.

The only linked C codec is `zstd-sys`; `cargo test --workspace --locked` and the
release addon build compile it for `aarch64-pc-windows-msvc`. Bzip2 uses
`libbz2-rs-sys`, and deflate uses `miniz_oxide`, both Rust implementations.
The portable WASM build uses the checksum-pinned x64 WASI SDK under Windows
emulation because that SDK has no Windows ARM64 host archive. Its compiler and
archiver produce wasm32 only; the addon still uses MSVC for the selected target.
Bun 1.4.2 has no Windows ARM64 artifact; the existing Windows x64 Bun lanes remain
the Bun runtime proof. Native Windows ARM64 support is qualified with Node.

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

The native watch lane requires events on Linux, macOS, and Windows and reports
actual edit latency. Run `FS_SAFE_TEST_SERIAL=1 pnpm check` to isolate local timing
checks from the other filesystem stress suites. Watch fixtures use normal OS
temporary storage; session scratch trees may suppress macOS filesystem events.

### Optional Linux Testbox

The manual `testbox-validation.yml` workflow prepares a 16-vCPU Ubuntu 24.04
Blacksmith Testbox with Node 24.21.0, pnpm 12.10.1, dependencies, the Rust WASM
target, and the pinned portable archive compiler. It leaves library builds and
validation commands to the caller and does not replace required CI checks.

Use an authenticated Blacksmith CLI with access to the repository and its
Blacksmith organization. From a full repository checkout, warm one session
through Crabbox:

```sh
CRABBOX_BLACKSMITH_IDLE_TIMEOUT=240m crabbox warmup --provider blacksmith-testbox \
  --blacksmith-org openclaw \
  --blacksmith-workflow .github/workflows/testbox-validation.yml \
  --blacksmith-job validate --blacksmith-ref main \
  --idle-timeout 240m --timing-json
```

Use a branch or tag containing the workflow for `--blacksmith-ref`; GitHub must
first have registered the workflow on the default branch. The job has a fixed
240-minute limit. Keep the idle timeout at that limit (240 minutes in the native
Blacksmith CLI) because the pinned Testbox action can miss active SSH sessions
behind a forwarded port. Bound commands by the remaining job time and leave time
to collect results and stop before the deadline.

Use the returned `tbx_...` ID for subsequent commands. The `fs-safe-testbox`
wrapper restores the prepared tool paths and WASM compiler settings in the SSH
shell. For example:

```sh
crabbox run --provider blacksmith-testbox --id <tbx_id> --timing-json -- \
  fs-safe-testbox pnpm check
crabbox stop --provider blacksmith-testbox <tbx_id>
```

Stop the session when finished and verify its terminal status. Blacksmith owns
checkout synchronization; record the tested source revision or diff, Testbox ID,
and Actions run. This backend is Linux-only and does not accept Crabbox's direct
SSH `--script` or `--download` flags. The workflow provides no application secrets.

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
The consumer must be separate from the source checkout; package resolution must
stay within its own `node_modules`, including pnpm's local `.pnpm` layout.
Workspace self-resolution, upward resolution, and external package links reject
before package imports or archive fixture creation.
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

Host-only smoke supplies the seven foreign packages using their unchanged real
manifests and clearly marked synthetic, non-executable payloads. Every foreign
metadata/tarball endpoint is checked before installation, so a missing fixture
cannot masquerade as successful platform filtering. These temporary fixtures
never enter `packages/`, release artifacts, or the publish manifest. They prove
installer filtering, not foreign native compilation or execution. Full release
collection uses the actual eight collected native tarballs instead. Run it with
`pnpm package:collect` after assembling all eight real bindings; missing targets
fail collection. `pnpm package:collect --allow-host-only` exercises the same
lifecycle boundary locally but proves only the host. Both collection commands
require the pnpm lifecycle CLI path; JavaScript CLIs run through Node and standalone
`@pnpm/exe` binaries run directly. Shell/cmd shims and PATH fallback are not used;
direct `node` invocation without lifecycle metadata is unsupported. Archive
codecs and their dependencies are packed from the installed dependency graph.

PR CI builds and executes all eight shipped bindings. The existing check names
stay stable; extra runner/runtime combinations add checks without changing the
repository ruleset. Native lanes run Node 24; the GNU host lanes also exercise
Bun 1.4.2 (as do macOS and Windows).

| Lane | Runner | Architecture / libc | Runtime |
| --- | --- | --- | --- |
| JavaScript check | `ubuntu-latest` | x64 / glibc | Node 22, 24, 26 |
| JavaScript check | `macos-15` | arm64 | Node 22, 24, 26 |
| JavaScript check | `fs-safe-windows-16core` (`windows-latest`) | x64 | Node 22, 24, 26 |
| Native check | `ubuntu-latest` | x64 / glibc | Node 24, Bun 1.4.2 |
| Native check (forced no-openat2) | `ubuntu-latest` | x64 / glibc | Node 24 |
| Native check | `ubuntu-24.04-arm` | arm64 / glibc | Node 24, Bun 1.4.2 |
| Native check | `macos-15` | arm64 | Node 24, Bun 1.4.2 |
| Native check | `macos-15-intel` | x64 | Node 24, Bun 1.4.2 |
| Native check | `fs-safe-windows-16core` (`windows-latest`) | x64 | Node 24, Bun 1.4.2 |
| Native check | `windows-2022` (standard hosted) | x64 | Node 24, Bun 1.4.2 |
| Windows ARM64 host | `windows-11-arm` | arm64 native and x64 emulated | Node 24 |
| Native check (Alpine 3.24) | `ubuntu-latest` | x64 / musl | Node 24 |
| Native check (Alpine 3.24) | `ubuntu-24.04-arm` | arm64 / musl | Node 24 |
| GNU glibc 2.28 build + Rocky Linux 8 load | `ubuntu-latest` | x64 / glibc | Node 24 |
| GNU glibc 2.28 build + Rocky Linux 8 load | `ubuntu-24.04-arm` | arm64 / glibc | Node 24 |
| Bundled package smoke | `ubuntu-latest`, `macos-15`, `fs-safe-windows-16core` | host | Node 22, 24 |
| Coverage | `ubuntu-latest`, `macos-15`, `fs-safe-windows-16core` | host | Node 22 |

Both musl lanes also run root-only package smoke with the real host binding.
The eight-target source build matrix still runs on release tags. The smoke writes manager versions,
cases, and synthetic-fixture scope to `release-artifacts/consumer-proof.json`.

## Docs

`pnpm docs:check` runs examples against the built package and compiles every
TypeScript block in `README.md`, the lock API signatures, and the custom stale-lock
policy example against its declarations. Run `pnpm build` first.
The compiler supplies typed application context for excerpted variables such as
`download`; package API calls and callback values remain fully type-checked.

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

Releases use protected `vX.Y.Z` tags on `main` and npm trusted publishing.
Contributors finish at PR merge; maintainers follow the
[release checklist](https://github.com/openclaw/fs-safe/blob/main/RELEASE-PREREQS.md).
Do not publish locally or add npm automation tokens.

## Reporting security issues

Suspected security issues belong in private disclosure first. See [`SECURITY.md`](https://github.com/openclaw/fs-safe/blob/main/SECURITY.md) in the repo for the current contact path. Don't open a public issue for a credential-stealing or sandbox-escape bug — coordinate the disclosure first.

## License

By contributing you agree that your contributions are licensed under the project's [MIT license](https://github.com/openclaw/fs-safe/blob/main/LICENSE).
