#!/usr/bin/env bash
set -euo pipefail
umask 077
export GIT_NO_REPLACE_OBJECTS=1

trusted_git() {
  GIT_NO_REPLACE_OBJECTS=1 command git --no-replace-objects "$@"
}

# Keep stdout exclusively for the gzip artifact stream consumed by Crabbox's
# --capture-stdout. Human-readable command output and failures stay on stderr.
exec 3>&1
exec 1>&2

candidate=""
harness=""
node_major=""
campaign_id=""
node22_capture=""
node24_capture=""
crabbox_version=""
workflow_database_id=""
workflow_file_sha256=""
expected_actions_run_number=""
campaign_initialized_at=""
expected_lane_sha256=""
while (($#)); do
  case "$1" in
    --candidate) candidate="${2-}"; shift 2 ;;
    --harness) harness="${2-}"; shift 2 ;;
    --node) node_major="${2-}"; shift 2 ;;
    --campaign-id) campaign_id="${2-}"; shift 2 ;;
    --node-22-capture) node22_capture="${2-}"; shift 2 ;;
    --node-24-capture) node24_capture="${2-}"; shift 2 ;;
    --crabbox-version) crabbox_version="${2-}"; shift 2 ;;
    --workflow-database-id) workflow_database_id="${2-}"; shift 2 ;;
    --workflow-file-sha256) workflow_file_sha256="${2-}"; shift 2 ;;
    --expected-actions-run-number) expected_actions_run_number="${2-}"; shift 2 ;;
    --campaign-initialized-at) campaign_initialized_at="${2-}"; shift 2 ;;
    --expected-lane-sha256) expected_lane_sha256="${2-}"; shift 2 ;;
    *) echo "unknown WSL2 proof option: $1" >&2; exit 2 ;;
  esac
done

sha='^[0-9a-f]{40}$'
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
[[ "$candidate" =~ $sha ]] || { echo "candidate must be an exact lowercase SHA" >&2; exit 2; }
[[ "$harness" =~ $sha ]] || { echo "harness must be an exact lowercase SHA" >&2; exit 2; }
[[ "$candidate" != "5f6ac8cafeb9f301e66b80b3b589dc4ebfd68136" ]] || {
  echo "candidate and security baseline must differ" >&2; exit 2;
}
[[ "$node_major" == "22" || "$node_major" == "24" ]] || {
  echo "node must be 22 or 24" >&2; exit 2;
}
[[ "$campaign_id" =~ $uuid && "$node22_capture" =~ $uuid && "$node24_capture" =~ $uuid ]] || {
  echo "campaign and capture bindings must be UUIDv4 values" >&2; exit 2;
}
[[ "$campaign_id" != "$node22_capture" && "$campaign_id" != "$node24_capture" &&
   "$node22_capture" != "$node24_capture" ]] || {
  echo "campaign and capture bindings must be distinct" >&2; exit 2;
}
[[ -n "$crabbox_version" && ${#crabbox_version} -le 128 &&
   ! "$crabbox_version" =~ [[:cntrl:]] ]] || {
  echo "Crabbox version binding is invalid" >&2; exit 2;
}
[[ "$workflow_database_id" =~ ^[1-9][0-9]*$ &&
   "$expected_actions_run_number" =~ ^[1-9][0-9]*$ ]] || {
  echo "hosted workflow ID and expected run number are invalid" >&2; exit 2;
}
[[ "$workflow_file_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "workflow byte hash is invalid" >&2; exit 2;
}
[[ "$expected_lane_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "expected WSL2 lane byte hash is invalid" >&2; exit 2;
}
[[ "$campaign_initialized_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || {
  echo "campaign initialization timestamp is invalid" >&2; exit 2;
}
capture_token="$node22_capture"
if [[ "$node_major" == "24" ]]; then capture_token="$node24_capture"; fi
remote_started_at="$(node -p 'new Date().toISOString()')"

kernel_release="$(uname -r)"
[[ "$kernel_release" =~ [Mm]icrosoft.*[Ww][Ss][Ll]2 ]] || {
  echo "native WSL2 kernel was not observed" >&2; exit 2;
}
kernel_version_hash="$(sha256sum /proc/version | awk '{print $1}')"
host_identity_hash="$(sha256sum /etc/machine-id | awk '{print $1}')"
actual_node="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$actual_node" == "$node_major" ]] || { echo "Node major mismatch" >&2; exit 2; }
[[ "$(pnpm --version)" == "11.25.0" ]] || { echo "pnpm version mismatch" >&2; exit 2; }
lane_script_path="$(realpath "$0")"
[[ -f "$lane_script_path" ]] || { echo "executed WSL2 lane script is not a file" >&2; exit 2; }
lane_script_hash="$(sha256sum "$lane_script_path" | awk '{print $1}')"
[[ "$lane_script_hash" == "$expected_lane_sha256" ]] || {
  echo "executed WSL2 lane differs from the reviewed immutable blob" >&2; exit 2;
}

work_root="$(realpath "$(TMPDIR=/tmp mktemp -d -t fs-safe-sync-lock-root-proof.XXXXXXXX)")"
filesystem_device="$(stat -c %d "$work_root")"
filesystem_type="$(stat -f -c %T "$work_root")"
temp_root="$work_root/worker-tmp"
mkdir -m 700 "$temp_root"
temp_root="$(realpath "$temp_root")"
export TMPDIR="$temp_root"
export TMP="$temp_root"
export TEMP="$temp_root"
[[ "$(node -p 'require("node:os").tmpdir()')" == "$temp_root" ]] || {
  echo "Node did not select the pinned worker temp root" >&2; exit 2;
}
temp_filesystem_device="$(stat -c %d "$temp_root")"
temp_filesystem_type="$(stat -f -c %T "$temp_root")"
temp_statfs_type="$(node -p 'require("node:fs").statfsSync(process.argv[1], { bigint: true }).type.toString()' "$temp_root")"
[[ "$temp_filesystem_device" == "$filesystem_device" &&
   "$temp_filesystem_type" == "$filesystem_type" ]] || {
  echo "pinned worker temp root is not on the admitted filesystem" >&2; exit 2;
}
output_root="$work_root/output"
mkdir -p "$output_root"
cleanup() {
  case "$work_root" in
    /tmp/fs-safe-sync-lock-root-proof.*) rm -rf -- "$work_root" ;;
    *) echo "refusing to remove unexpected proof root: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

checkout_exact() {
  local directory="$1"
  local commit="$2"
  trusted_git init -q "$directory"
  trusted_git -C "$directory" config core.autocrlf false
  trusted_git -C "$directory" config core.eol lf
  trusted_git -C "$directory" remote add origin https://github.com/openclaw/fs-safe.git
  trusted_git -C "$directory" fetch -q --no-tags --depth=1 origin "$commit"
  trusted_git -C "$directory" checkout -q --detach FETCH_HEAD
  [[ "$(trusted_git -C "$directory" rev-parse HEAD)" == "$commit" ]] || {
    echo "exact checkout failed for $commit" >&2; exit 2;
  }
}

verify_harness_exact() {
  local root="$1"
  local relative file expected_blob actual_blob
  local -a immutable_files
  mapfile -t immutable_files < <(
    {
      trusted_git -C "$root" ls-tree -r --name-only "$harness" -- benchmarks
      printf '%s\n' .crabbox.yaml .gitattributes \
        .github/workflows/sync-lock-root-performance-proof.yml \
        package.json pnpm-lock.yaml pnpm-workspace.yaml
    } | LC_ALL=C sort -u
  )
  for relative in "${immutable_files[@]}"; do
    file="$root/$relative"
    [[ -f "$file" && ! -L "$file" && "$(stat -c %h "$file")" == "1" ]] || {
      echo "remote harness input is missing or aliased: $relative" >&2; exit 2;
    }
    expected_blob="$(trusted_git -C "$root" rev-parse "$harness:$relative")"
    actual_blob="$(trusted_git -C "$root" hash-object --no-filters -- "$file")"
    [[ "$actual_blob" == "$expected_blob" ]] || {
      echo "remote harness input differs from reviewed blob: $relative" >&2; exit 2;
    }
  done
}

rustup target add wasm32-unknown-unknown
artifact_names=()
for order in abba baab; do
  for study in source-comparison same-source-rebuild same-artifact; do
    study_root="$work_root/$order-$study"
    harness_root="$study_root/harness"
    candidate_root="$study_root/candidate"
    baseline_root="$study_root/baseline"
    plan_path="$study_root/plan.json"
    snapshot_path="$study_root/before.json"
    report_root="$study_root/report"
    github_output="$study_root/github-output"
    baseline="${candidate}"
    control="rebuild"
    if [[ "$study" == "source-comparison" ]]; then
      baseline="5f6ac8cafeb9f301e66b80b3b589dc4ebfd68136"
    elif [[ "$study" == "same-artifact" ]]; then
      control="same-artifact"
    fi
    artifact="sync-lock-root-wsl2-node-$node_major-$order-$study-$capture_token-1"
    artifact_names+=("$artifact")
    mkdir -p "$study_root"
    checkout_exact "$harness_root" "$harness"
    verify_harness_exact "$harness_root"
    observed_lane_script_hash="$(
      sha256sum "$harness_root/benchmarks/sync-lock-root-crabbox-wsl2.sh" | awk '{print $1}'
    )"
    [[ "$lane_script_hash" == "$observed_lane_script_hash" ]] || {
      echo "executed WSL2 lane script is not the reviewed harness blob" >&2; exit 2;
    }
    checkout_exact "$candidate_root" "$candidate"
    checkout_exact "$baseline_root" "$baseline"

    export GITHUB_OUTPUT="$github_output"
    export GITHUB_REPOSITORY="openclaw/fs-safe"
    export GITHUB_RUN_ID="$capture_token"
    # Generic method-audit schema marker only. The outer single-use capture
    # token, retained wrapper receipt, and cohort ordering establish provenance.
    export GITHUB_RUN_ATTEMPT="1"
    export GITHUB_JOB="wsl2-node-$node_major-$order-$study"
    export RUNNER_ENVIRONMENT="crabbox-wsl2"
    export RUNNER_OS="Linux"
    export RUNNER_ARCH="$(uname -m)"
    export METHOD_PLATFORM="wsl2"
    export METHOD_COMPARE_REF="$baseline"
    export METHOD_CANDIDATE_REF="$candidate"
    export METHOD_ITERATIONS="100"
    export METHOD_SAMPLES="9"
    export METHOD_FILTER="syncLockRoot/"
    export METHOD_ORDER="$order"
    export METHOD_BLOCKS="5"
    export METHOD_NATIVE_MODE="off"
    export METHOD_NODE_VERSION="$node_major"
    export METHOD_CONTROL="$control"
    export METHOD_TIMEOUT_MINUTES="120"
    export METHOD_EXPECTED_HARNESS_SHA="$harness"
    export METHOD_WORKFLOW_SHA="$harness"
    export METHOD_EVENT_SHA="$harness"
    export METHOD_WORKFLOW_REF="openclaw/fs-safe/.github/workflows/sync-lock-root-performance-proof.yml@$harness"
    export METHOD_WORKFLOW_PATH=".github/workflows/sync-lock-root-performance-proof.yml"
    export METHOD_MATRIX_PLATFORM="wsl2"
    export SYNC_LOCK_ROOT_CAMPAIGN_ID="$campaign_id"
    export SYNC_LOCK_ROOT_WSL2_NODE_22_CAPTURE="$node22_capture"
    export SYNC_LOCK_ROOT_WSL2_NODE_24_CAPTURE="$node24_capture"
    export SYNC_LOCK_ROOT_EXECUTION_SURFACE="wsl2-crabbox"
    export SYNC_LOCK_ROOT_WSL2_CAPTURE_TOKEN="$capture_token"
    export SYNC_LOCK_ROOT_WSL2_FILESYSTEM_DEVICE="$filesystem_device"
    export SYNC_LOCK_ROOT_WSL2_FILESYSTEM_TYPE="$filesystem_type"
    export SYNC_LOCK_ROOT_WSL2_HOST_IDENTITY_HASH="$host_identity_hash"
    export SYNC_LOCK_ROOT_WSL2_KERNEL_RELEASE="$kernel_release"
    export SYNC_LOCK_ROOT_WSL2_VERSION_HASH="$kernel_version_hash"
    export SYNC_LOCK_ROOT_WSL2_TEMP_PATH="$temp_root"
    export SYNC_LOCK_ROOT_WSL2_TEMP_DEVICE="$temp_filesystem_device"
    export SYNC_LOCK_ROOT_WSL2_TEMP_FILESYSTEM_TYPE="$temp_filesystem_type"
    export SYNC_LOCK_ROOT_WSL2_TEMP_STATFS_TYPE="$temp_statfs_type"
    export SYNC_LOCK_ROOT_CRABBOX_VERSION="$crabbox_version"
    export SYNC_LOCK_ROOT_WORKFLOW_DATABASE_ID="$workflow_database_id"
    export SYNC_LOCK_ROOT_WORKFLOW_FILE_SHA256="$workflow_file_sha256"
    export SYNC_LOCK_ROOT_EXPECTED_ACTIONS_RUN_NUMBER="$expected_actions_run_number"
    export SYNC_LOCK_ROOT_CAMPAIGN_INITIALIZED_AT="$campaign_initialized_at"

    node "$harness_root/benchmarks/method-audit-evidence.mjs" prepare \
      --harness-root "$harness_root" --output "$plan_path"
    plan_hash="$(sha256sum "$plan_path" | awk '{print $1}')"
    pnpm --dir "$harness_root" install --frozen-lockfile
    pnpm --dir "$candidate_root" install --frozen-lockfile
    pnpm --dir "$candidate_root" build
    if [[ "$study" != "same-artifact" ]]; then
      pnpm --dir "$baseline_root" install --frozen-lockfile
      pnpm --dir "$baseline_root" build
    fi
    node "$harness_root/benchmarks/method-audit-evidence.mjs" snapshot \
      --plan "$plan_path" --expected-plan-file-hash "$plan_hash" \
      --harness-root "$harness_root" --candidate-root "$candidate_root" \
      --baseline-root "$baseline_root" --output "$snapshot_path"
    node "$harness_root/benchmarks/method-audit-evidence.mjs" measure \
      --plan "$plan_path" --expected-plan-file-hash "$plan_hash" --before "$snapshot_path" \
      --harness-root "$harness_root" --candidate-root "$candidate_root" \
      --baseline-root "$baseline_root" --output-root "$report_root"
    node "$harness_root/benchmarks/sync-lock-root-finalize-study.mjs" \
      --plan "$plan_path" --output-root "$report_root" --artifact-name "$artifact" \
      --surface wsl2 --node "$node_major" --order "$order" --control "$study"
    mv "$report_root" "$output_root/$artifact"
  done
done

receipt="$output_root/wsl2-remote-receipt-node-$node_major.json"
remote_finished_at="$(node -p 'new Date().toISOString()')"
node - "$receipt" "$candidate" "$harness" "$node_major" "$campaign_id" \
  "$node22_capture" "$node24_capture" "$capture_token" "$remote_started_at" \
  "$remote_finished_at" "$host_identity_hash" "$kernel_release" "$kernel_version_hash" \
  "$filesystem_device" "$filesystem_type" "$temp_root" "$temp_filesystem_device" \
  "$temp_filesystem_type" "$temp_statfs_type" "$crabbox_version" "$lane_script_hash" \
  "$workflow_database_id" "$workflow_file_sha256" "$expected_actions_run_number" \
  "$campaign_initialized_at" \
  "${artifact_names[@]}" <<'NODE'
const fs = require("node:fs");
const [file, candidateSha, harnessSha, node, campaignId, node22, node24, captureToken,
  startedAt, finishedAt, identityHash, kernelRelease, versionReceiptHash,
  filesystemDevice, filesystemType, tempPath, tempDevice, tempFilesystemType,
  tempStatfsType, crabboxVersion, laneScriptSha256, workflowDatabaseId,
  workflowFileSha256, expectedActionsRunNumber, initializedAt,
  ...artifacts] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
  schema: "fs-safe-sync-lock-root-crabbox-remote-v2",
  campaign: {
    schema: "fs-safe-sync-lock-root-campaign-v3",
    id: campaignId,
    actions: {
      repository: "openclaw/fs-safe",
      workflowDatabaseId,
      workflowPath: ".github/workflows/sync-lock-root-performance-proof.yml",
      harnessSha,
      workflowFileSha256,
      expectedActionsRunNumber: Number(expectedActionsRunNumber),
      runAttempt: 1,
      initializedAt,
      clockPolicy: "campaign-initialized-no-later-than-actions-run-v1",
    },
    captures: { "22": node22, "24": node24 },
    crabbox: {
      timingSchema: "crabbox-go-TimingReport-syncDelegated-omitempty-v1",
      version: crabboxVersion,
    },
  },
  candidateSha,
  baselineSha: "5f6ac8cafeb9f301e66b80b3b589dc4ebfd68136",
  harnessSha,
  node,
  captureToken,
  startedAt,
  finishedAt,
  host: {
    identityHash,
    kernelRelease,
    versionReceiptHash,
    filesystemDevice,
    filesystemType,
    tempRoot: {
      path: tempPath,
      realPath: tempPath,
      device: tempDevice,
      filesystemType: tempFilesystemType,
      statfsType: tempStatfsType,
      environment: { TMPDIR: tempPath, TMP: tempPath, TEMP: tempPath },
    },
  },
  laneScriptSha256,
  artifacts,
}, null, 2) + "\n", { flag: "wx" });
NODE

tar --format=ustar -C "$output_root" -czf - . >&3
