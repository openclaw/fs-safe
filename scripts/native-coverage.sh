#!/usr/bin/env bash
# Linux native unit + addon coverage; run after pnpm build.
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTUP_TOOLCHAIN=nightly-2026-09-25
mkdir -p coverage-rust
# Keep WASM/package compilation outside this environment: only the native crate
# and its dependencies belong to the instrumented host build.
coverage_env=$(cargo llvm-cov show-env --sh --branch)
eval "$coverage_env"
cargo llvm-cov clean --workspace
cargo test --locked -p fs-safe-native --lib
# The native crate is a cdylib. Stage this instrumented artifact, not napi's
# normal release build, so Vitest and its children contribute Rust counters.
cargo build --locked -p fs-safe-native
cp "$CARGO_LLVM_COV_TARGET_DIR/debug/libfs_safe_native.so" native/fs-safe-native.linux-x64-gnu.node
node scripts/stage-host-native.mjs
report_args=(--ignore-filename-regex '(^|/)(archive-core|archive-wasm)/')
cargo llvm-cov report "${report_args[@]}" --json --summary-only --output-path coverage-rust/unit-summary.json
export LLVM_PROFILE_FILE="$CARGO_LLVM_COV_TARGET_DIR/addon-%p-%m.profraw"
FS_SAFE_NATIVE_MODE=require node scripts/native-mode-smoke.mjs require
FS_SAFE_TEST_WATCH_EVENTS=1 pnpm test --maxWorkers=2 --testTimeout=30000 \
  test/native- test/root-native- test/retained-file.test.ts \
  test/staged-file.test.ts test/staged-file-failures.test.ts \
  test/staged-symlink.test.ts test/staged-symlink-error-settlement.test.ts \
  test/watch.test.ts test/watch-persistent.test.ts test/watch-platforms.test.ts \
  test/watch-alias.test.ts test/watch-hints.test.ts test/watch-memory.test.ts \
  test/watch-failure-coverage.test.ts
# A missing profile is a broken instrumentation setup, not zero coverage.
compgen -G "$CARGO_LLVM_COV_TARGET_DIR/addon-*.profraw" > /dev/null
cargo llvm-cov report "${report_args[@]}" --lcov --output-path coverage-rust/lcov.info
cargo llvm-cov report "${report_args[@]}" --json --summary-only --output-path coverage-rust/coverage-summary.json
node scripts/summarize-native-coverage.mjs
