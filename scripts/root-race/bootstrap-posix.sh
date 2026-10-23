#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null || ! test "$(node --version)" = v24.22.1; then
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) target=darwin-arm64 ;;
    Linux/x86_64) target=linux-x64 ;;
    *) exit 2 ;;
  esac
  mkdir -p "$HOME/.local/node"
  cd "$HOME/.local/node"
  curl -fsSLO https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
  archive=$(awk -v target="$target" '$2 ~ target "\\.tar\\.gz$" { print $2 }' SHASUMS256.txt)
  curl -fsSLO "https://nodejs.org/dist/v24.22.1/$archive"
  shasum -a 256 -c <(grep " $archive$" SHASUMS256.txt)
  tar xzf "$archive" --strip-components=1
  export PATH="$HOME/.local/node/bin:$PATH"
  cd - >/dev/null
fi
if ! command -v pnpm >/dev/null || ! test "$(pnpm_config_pm_on_fail=ignore pnpm --version)" = 12.15.0; then npm install -g pnpm@12.15.0 --prefix "$HOME/.local"; fi
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm native:build
node scripts/root-race/run.mjs --seeds=6 --seconds=2 --output=.artifacts/mac-smoke.jsonl
node scripts/root-race/run.mjs --seeds=60 --seconds=20 --output=.artifacts/mac-races.jsonl
