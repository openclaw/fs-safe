#!/bin/bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v rustup >/dev/null; then
  rustup_tmp=$(mktemp -d)
  trap 'rm -rf -- "$rustup_tmp"' EXIT
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$rustup_tmp/install.sh"
  sh "$rustup_tmp/install.sh" -y --profile minimal
  rm -rf -- "$rustup_tmp"
  trap - EXIT
fi
rustup target add wasm32-unknown-unknown
pnpm build
pnpm native:build
node scripts/root-race/run.mjs --control=quiet --seeds=1 --seconds=0 --output=.artifacts/linux-control.jsonl
node scripts/root-race/run.mjs --seeds=6 --seconds=2 --output=.artifacts/linux-smoke.jsonl
node scripts/root-race/campaign.mjs
