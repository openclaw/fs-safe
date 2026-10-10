#!/bin/sh
set -eu

if [ "$(uname -s)" != "FreeBSD" ]; then
  echo "This installer requires FreeBSD" >&2
  exit 1
fi

npm install --global pnpm@12.10.1 --ignore-scripts
if [ "$FS_SAFE_FREEBSD_TARGET" = "freebsd-arm64" ]; then
  # pnpm ships no native arm64 FreeBSD artifact. Build the identical release;
  # keep the npm package's auxiliary payload beside the resulting executable.
  revision=343f3c4198b43dce5e58bc7de9927cb96aed59fc
  source_dir=$(mktemp -d)
  git -C "$source_dir" init -q
  git -C "$source_dir" fetch --depth 1 https://github.com/pnpm/pnpm.git "$revision"
  git -C "$source_dir" checkout --detach -q FETCH_HEAD
  test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
  # Bootstrap from the locked registry sources, before pnpm can materialize its
  # own .pnpm/crates directory. Cargo discovers config from the working directory.
  # This is only the build tool. Avoid release optimization and debug-info cost
  # inside the emulated guest; fs-safe itself is still built with --release.
  CARGO_PROFILE_DEV_DEBUG=0 cargo build --manifest-path "$source_dir/Cargo.toml" --locked -p pnpm-cli --bin pnpm
  install -m 755 "$source_dir/target/debug/pnpm" "$(npm root --global)/pnpm/pnpm"
fi

test "$(pnpm --version)" = "12.10.1"
