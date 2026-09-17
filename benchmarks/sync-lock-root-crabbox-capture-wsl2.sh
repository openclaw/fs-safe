#!/usr/bin/env bash
set -euo pipefail
umask 077
export GIT_NO_REPLACE_OBJECTS=1

trusted_git() {
  GIT_NO_REPLACE_OBJECTS=1 command git --no-replace-objects "$@"
}

mode="capture"
repository_root=""
candidate=""
harness=""
campaign_id=""
node22_capture=""
node24_capture=""
crabbox_version=""
workflow_database_id=""
workflow_file_sha256=""
expected_actions_run_number=""
campaign_initialized_at=""
node_major=""
static_host=""
output_root=""
while (($#)); do
  case "$1" in
    --initialize) mode="initialize"; shift ;;
    --repository-root) repository_root="${2-}"; shift 2 ;;
    --candidate) candidate="${2-}"; shift 2 ;;
    --harness) harness="${2-}"; shift 2 ;;
    --campaign-id) campaign_id="${2-}"; shift 2 ;;
    --node-22-capture) node22_capture="${2-}"; shift 2 ;;
    --node-24-capture) node24_capture="${2-}"; shift 2 ;;
    --crabbox-version) crabbox_version="${2-}"; shift 2 ;;
    --workflow-database-id) workflow_database_id="${2-}"; shift 2 ;;
    --workflow-file-sha256) workflow_file_sha256="${2-}"; shift 2 ;;
    --expected-actions-run-number) expected_actions_run_number="${2-}"; shift 2 ;;
    --campaign-initialized-at) campaign_initialized_at="${2-}"; shift 2 ;;
    --node) node_major="${2-}"; shift 2 ;;
    --static-host) static_host="${2-}"; shift 2 ;;
    --output-root) output_root="${2-}"; shift 2 ;;
    *) echo "unknown WSL2 outer capture option: $1" >&2; exit 2 ;;
  esac
done

sha='^[0-9a-f]{40}$'
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
[[ "$candidate" =~ $sha && "$harness" =~ $sha ]] || {
  echo "candidate and harness must be exact lowercase SHAs" >&2; exit 2;
}
[[ "$campaign_id" =~ $uuid && "$node22_capture" =~ $uuid && "$node24_capture" =~ $uuid ]] || {
  echo "campaign and capture bindings must be UUIDv4 values" >&2; exit 2;
}
[[ "$campaign_id" != "$node22_capture" && "$campaign_id" != "$node24_capture" &&
   "$node22_capture" != "$node24_capture" ]] || {
  echo "campaign and capture bindings must be distinct" >&2; exit 2;
}
[[ -n "$crabbox_version" && ${#crabbox_version} -le 128 ]] || {
  echo "exact inspected Crabbox version is required" >&2; exit 2;
}
[[ ! "$crabbox_version" =~ [[:cntrl:]] ]] || {
  echo "Crabbox version contains control bytes" >&2; exit 2;
}
[[ "$workflow_database_id" =~ ^[1-9][0-9]*$ &&
   "$expected_actions_run_number" =~ ^[1-9][0-9]*$ ]] || {
  echo "hosted workflow ID and expected run number are invalid" >&2; exit 2;
}
[[ "$workflow_file_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "workflow byte hash is invalid" >&2; exit 2;
}

[[ -n "$repository_root" ]] || { echo "repository root is required" >&2; exit 2; }
repo_root="$(realpath "$repository_root")"
[[ "$(trusted_git -C "$repo_root" rev-parse --show-toplevel)" == "$repo_root" ]] || {
  echo "outer capture repository root is not canonical" >&2; exit 2;
}
[[ "$(trusted_git -C "$repo_root" rev-parse HEAD)" == "$harness" ]] || {
  echo "outer capture checkout is not the reviewed harness commit" >&2; exit 2;
}
state_root="$repo_root/artifacts-sync-lock-root-state-v1"
launcher_root="$state_root/launchers"
launcher_path="$launcher_root/$campaign_id.sh"
[[ -d "$state_root" && ! -L "$state_root" && "$(stat -c %a "$state_root")" == "700" &&
   -d "$launcher_root" && ! -L "$launcher_root" &&
   "$(stat -c %a "$launcher_root")" == "700" ]] || {
  echo "immutable launcher directories are not private" >&2; exit 2;
}
[[ "$(realpath "$0")" == "$launcher_path" && -f "$launcher_path" && ! -L "$launcher_path" &&
   "$(stat -c %h "$launcher_path")" == "1" && "$(stat -c %a "$launcher_path")" == "500" ]] || {
  echo "outer capture must execute the private immutable campaign launcher" >&2; exit 2;
}
expected_launcher_blob="$(trusted_git -C "$repo_root" rev-parse \
  "$harness:benchmarks/sync-lock-root-crabbox-capture-wsl2.sh")"
actual_launcher_blob="$(trusted_git -C "$repo_root" hash-object --no-filters -- "$launcher_path")"
[[ "$actual_launcher_blob" == "$expected_launcher_blob" ]] || {
  echo "executed capture launcher differs from its reviewed immutable blob" >&2; exit 2;
}
mapfile -t harness_files < <(
  {
    trusted_git -C "$repo_root" ls-tree -r --name-only "$harness" -- benchmarks
    printf '%s\n' .crabbox.yaml .gitattributes .github/workflows/sync-lock-root-performance-proof.yml \
      package.json pnpm-lock.yaml pnpm-workspace.yaml
  } | LC_ALL=C sort -u
)
for relative in "${harness_files[@]}"; do
  file="$repo_root/$relative"
  [[ -f "$file" && ! -L "$file" && "$(stat -c %h "$file")" == "1" ]] || {
    echo "reviewed harness input is missing or aliased: $relative" >&2; exit 2;
  }
  expected_blob="$(trusted_git -C "$repo_root" rev-parse "$harness:$relative")"
  actual_blob="$(trusted_git -C "$repo_root" hash-object --no-filters -- "$file")"
  [[ "$actual_blob" == "$expected_blob" ]] || {
    echo "harness input differs byte-for-byte from reviewed blob: $relative" >&2; exit 2;
  }
done
immutable_workflow_sha256="$(trusted_git -C "$repo_root" cat-file blob \
  "$harness:.github/workflows/sync-lock-root-performance-proof.yml" | sha256sum | awk '{print $1}')"
immutable_lane_sha256="$(trusted_git -C "$repo_root" cat-file blob \
  "$harness:benchmarks/sync-lock-root-crabbox-wsl2.sh" | sha256sum | awk '{print $1}')"
[[ "$immutable_workflow_sha256" == "$workflow_file_sha256" ]] || {
  echo "predeclared workflow byte hash differs from reviewed blob" >&2; exit 2;
}
cd "$repo_root"
state_directory="$state_root/$campaign_id"
campaign_state="$state_directory/campaign-state.json"
install -d -m 700 "$state_root"

if [[ "$mode" == "initialize" ]]; then
  [[ -z "$node_major" && -z "$static_host" && -z "$output_root" &&
     -z "$campaign_initialized_at" ]] || {
    echo "initialization does not accept capture-only options" >&2; exit 2;
  }
  created_at="$(node -p 'new Date().toISOString()')"
  node benchmarks/sync-lock-root-campaign-state.mjs initialize \
    --candidate "$candidate" --harness "$harness" --campaign-id "$campaign_id" \
    --node-22-capture "$node22_capture" --node-24-capture "$node24_capture" \
    --crabbox-version "$crabbox_version" --workflow-database-id "$workflow_database_id" \
    --workflow-file-sha256 "$workflow_file_sha256" \
    --expected-actions-run-number "$expected_actions_run_number" --now "$created_at"
  exit 0
fi

[[ "$campaign_initialized_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || {
  echo "capture requires the exact initialized campaign timestamp" >&2; exit 2;
}
[[ "$node_major" == "22" || "$node_major" == "24" ]] || {
  echo "node must be 22 or 24" >&2; exit 2;
}
[[ -n "$static_host" && "$static_host" != -* ]] || {
  echo "static host is invalid" >&2; exit 2;
}
[[ -n "$output_root" && -f "$campaign_state" ]] || {
  echo "initialize the fixed campaign state before capture" >&2; exit 2;
}
capture_token="$node22_capture"
if [[ "$node_major" == "24" ]]; then capture_token="$node24_capture"; fi
consumption="$state_directory/node-$node_major-consumption.json"
state_result="$state_directory/node-$node_major-result.json"
[[ ! -e "$consumption" && ! -e "$state_result" ]] || {
  echo "campaign capture token was already consumed" >&2; exit 2;
}

actual_crabbox_version="$(crabbox --version)"
[[ "$actual_crabbox_version" == "$crabbox_version" ]] || {
  echo "Crabbox version differs from the predeclared campaign" >&2; exit 2;
}
[[ ! -L "$output_root" ]] || { echo "output root cannot be a link" >&2; exit 2; }
install -d -m 700 "$output_root"
output_root="$(realpath "$output_root")"
capture_directory="$output_root/wsl2-capture-node-$node_major"
archive="$capture_directory/archive.tar.gz"
archive_validation="$capture_directory/archive-validation.json"
clock="$capture_directory/capture-clock.json"
remote_root="$capture_directory/remote"
timing="$capture_directory/crabbox-timing.json"
version_file="$capture_directory/crabbox-version.txt"
wrapper_log="$capture_directory/wrapper.stderr"
outer="$capture_directory/outer-receipt.json"
started_at="$(node -p 'new Date().toISOString()')"

node benchmarks/sync-lock-root-campaign-state.mjs consume \
  --candidate "$candidate" --harness "$harness" --campaign-id "$campaign_id" \
  --node-22-capture "$node22_capture" --node-24-capture "$node24_capture" \
  --crabbox-version "$crabbox_version" --node "$node_major" \
  --workflow-database-id "$workflow_database_id" \
  --workflow-file-sha256 "$workflow_file_sha256" \
  --expected-actions-run-number "$expected_actions_run_number" \
  --campaign-initialized-at "$campaign_initialized_at" \
  --output-root "$output_root" --now "$started_at"

mkdir -m 700 "$capture_directory"
mkdir -m 700 "$remote_root"
printf '%s\n' "$actual_crabbox_version" >"$version_file"
chmod 600 "$version_file"
install -m 600 "$campaign_state" "$capture_directory/campaign-state.json"
install -m 600 "$consumption" "$capture_directory/capture-consumption.json"
set +e
crabbox run --provider ssh --target windows --windows-mode wsl2 \
  --static-host "$static_host" --timing-json --capture-stdout "$archive" \
  --script benchmarks/sync-lock-root-crabbox-wsl2.sh -- \
  --candidate "$candidate" --harness "$harness" --node "$node_major" \
  --campaign-id "$campaign_id" --node-22-capture "$node22_capture" \
  --node-24-capture "$node24_capture" --crabbox-version "$crabbox_version" \
  --workflow-database-id "$workflow_database_id" \
  --workflow-file-sha256 "$workflow_file_sha256" \
  --expected-actions-run-number "$expected_actions_run_number" \
  --campaign-initialized-at "$campaign_initialized_at" \
  --expected-lane-sha256 "$immutable_lane_sha256" \
  >"$timing" 2>"$wrapper_log"
wrapper_status=$?
finished_at="$(node -p 'new Date().toISOString()')"
validation_status=1
extraction_status=1
if ((wrapper_status == 0)); then
  node benchmarks/sync-lock-root-tar.mjs \
    --archive "$archive" --output "$archive_validation"
  validation_status=$?
fi
if ((wrapper_status == 0 && validation_status == 0)); then
  tar --extract --gzip --file "$archive" --directory "$remote_root" \
    --no-same-owner --no-same-permissions
  extraction_status=$?
fi
set -e
[[ -f "$archive" ]] || : >"$archive"
[[ -f "$archive_validation" ]] || printf '%s\n' \
  '{"schema":"fs-safe-sync-lock-root-tar-validation-v1","accepted":false,"failure":{"kind":"not-run"}}' \
  >"$archive_validation"
chmod 600 "$archive" "$archive_validation" "$timing" "$wrapper_log"

node - "$clock" "$campaign_state" "$node_major" "$capture_token" "$started_at" \
  "$finished_at" "$wrapper_status" "$validation_status" "$extraction_status" <<'NODE'
const fs = require("node:fs");
const [file, campaignFile, node, captureToken, startedAt, finishedAt,
  wrapperExitCode, validationExitCode, extractionExitCode] = process.argv.slice(2);
const campaign = JSON.parse(fs.readFileSync(campaignFile)).campaign;
fs.writeFileSync(file, JSON.stringify({
  schema: "fs-safe-sync-lock-root-capture-clock-v1",
  campaign,
  node,
  captureToken,
  startedAt,
  finishedAt,
  wrapperExitCode: Number(wrapperExitCode),
  validationExitCode: Number(validationExitCode),
  extractionExitCode: Number(extractionExitCode),
}, null, 2) + "\n", { flag: "wx", mode: 0o600 });
NODE

set +e
node benchmarks/sync-lock-root-crabbox-capture.mjs \
  --clock "$clock" --timing "$timing" --wrapper-log "$wrapper_log" \
  --archive "$archive" --archive-validation "$archive_validation" \
  --crabbox-version "$version_file" --campaign-state "$campaign_state" \
  --consumption "$consumption" --remote "$remote_root" --output "$outer" \
  --repository-root "$repo_root" --harness-sha "$harness" \
  --executed-capture "$launcher_path"
finalizer_status=$?
set -e
state_finished_at="$(node -p 'new Date().toISOString()')"
node benchmarks/sync-lock-root-campaign-state.mjs complete \
  --campaign-id "$campaign_id" --node "$node_major" --outer "$outer" \
  --now "$state_finished_at" --finalizer-status "$finalizer_status"
install -m 600 "$state_result" "$capture_directory/capture-state-receipt.json"

if ((wrapper_status != 0)); then exit "$wrapper_status"; fi
if ((validation_status != 0)); then exit "$validation_status"; fi
if ((extraction_status != 0)); then exit "$extraction_status"; fi
exit "$finalizer_status"
