import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const ARCHIVES = [
  ["22.23.2", "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"],
  ["24.20.0", "2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"],
] as const;
const temporaryDirectories: string[] = [];
let workflowPromise: Promise<string> | undefined;

function workflow(): Promise<string> {
  workflowPromise ??= readFile(".github/workflows/ci.yml", "utf8").then((text) =>
    text.replaceAll("\r\n", "\n"));
  return workflowPromise;
}

async function policy(): Promise<string> {
  const lines = (await workflow()).split("\n");
  const start = lines.indexOf("          # BEGIN STAGING POLICY: also exercised by the shell contract tests.");
  const end = lines.indexOf("          # END STAGING POLICY");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).map((line) => line.slice(10)).join("\n");
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fs-safe-staging-contract-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runPolicy(source: string, body: string, args: string[] = []) {
  return spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-s", "--", ...args], {
    input: `set -Eeuo pipefail\nstage=bootstrap subject=bootstrap reason=predicate receipt_ready=0\n${source}\n${body}\n`,
    env: { HOME: "/nonexistent", PATH: "/usr/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("authenticated credential-proof staging contract", () => {
  it("authenticates before checkout, keeps the stage private, then publishes the checked manifest", async () => {
    const source = await workflow();
    const start = source.indexOf("      - name: Authenticate and privately stage proof tools before checkout");
    const checkout = source.indexOf("      - name: Check out exact reviewed proof harness");
    const finish = source.indexOf("      - name: Finish and publish the private authenticated proof stage");
    const proof = source.indexOf("      - name: Prove split real and effective credential behavior");
    expect(start).toBeGreaterThan(-1);
    expect(checkout).toBeGreaterThan(start);
    expect(finish).toBeGreaterThan(checkout);
    expect(proof).toBeGreaterThan(finish);
    const bootstrap = source.slice(start, checkout);
    expect(bootstrap).toContain('/usr/bin/mkdir -m 0700 -- "$stage_root"');
    expect(bootstrap).toContain('"$stage_identity:700"');
    expect(bootstrap).toContain('"$stage_identity:555"');
    expect(bootstrap).toContain('"$manifest_identity" && "$file_hash" = "$manifest_hash"');
    expect(bootstrap).toContain("declare -f failure_json write_staging_failure");
    expect(bootstrap).toContain('> "$stage_root/.finish-stage"');
    expect(source.slice(finish, proof)).toContain('"$STAGE_ROOT/.finish-stage"');
    expect(bootstrap).not.toContain("RUNNER_TOOL_CACHE");
    expect(bootstrap).not.toContain("/opt/");
    expect(bootstrap).not.toContain("command -v");
    expect(bootstrap).not.toContain("BASH_COMMAND");
    expect(bootstrap).toContain('inspect_metadata "/usr/bin/$name" 0 0 268435456');
    const download = bootstrap.lastIndexOf("/usr/bin/curl --disable");
    const authenticate = bootstrap.lastIndexOf("          authenticate_node_archive\n");
    const execute = bootstrap.indexOf('actual_version=$("$stage_root/node" --version)');
    expect(download).toBeGreaterThan(bootstrap.lastIndexOf("          validate_system_tools\n"));
    expect(authenticate).toBeGreaterThan(download);
    expect(execute).toBeGreaterThan(authenticate);
  });

  it("preserves the coordinator's exact initialization receipt allowlist", async () => {
    const source = await policy();
    const line = source.split("\n").find((item) => item.startsWith("initial_receipt='"))!;
    const initial = line.slice("initial_receipt='".length, -1);
    expect(JSON.parse(initial).failure.code).toBe("PROOF_NOT_STARTED");
    const coordinator = await readFile("scripts/secure-file-credential-proof.mjs", "utf8");
    expect(coordinator).toContain(`  '${initial}\\n',`);
    const allowlist = coordinator.slice(coordinator.indexOf("const FAILURE_RECEIPTS"), coordinator.indexOf("const ALLOWED_ARGUMENTS"));
    expect(allowlist).not.toContain("STAGING_FAILED");
    expect(allowlist.split("receiptAllowlisted")).toHaveLength(3);
    expect(coordinator).toContain('!hasExactKeys(value.nodeArchive, ["version", "sha256"])');
    for (const [, digest] of ARCHIVES) expect(coordinator).toContain(digest);
  });
});

describe.skipIf(process.platform !== "linux")("credential-proof shell policies", () => {
  it.each(ARCHIVES)("selects only the pinned official archive for %s", async (version, digest) => {
    const result = runPolicy(await policy(), 'node_version="$1"; select_node_archive; printf "%s\\n%s\\n" "$archive_url" "$archive_sha256"', [version]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz\n${digest}\n`);
  });

  it.each(["22", "v22.23.2", "24.20.0/../other", "22.23.2\nextra"])("rejects unsupported archive selector %j", async (version) => {
    const result = runPolicy(await policy(), 'node_version="$1"; select_node_archive; printf executed', [version]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("executed");
    expect(JSON.parse(result.stdout).failure.diagnostic.reason).toBe("unsupported-runtime");
  });

  it.each([
    ["0", "0", "755", "1", "100", true],
    ["0", "0", "555", "1", "100", true],
    ["1001", "0", "755", "1", "100", false],
    ["0", "1001", "755", "1", "100", false],
    ["0", "0", "777", "1", "100", false],
    ["0", "0", "1777", "1", "100", false],
    ["0", "0", "4755", "1", "100", false],
    ["0", "0", "755", "2", "100", false],
    ["0", "0", "755", "1", "0", false],
    ["0", "0", "755", "1", "1025", false],
  ])("enforces ownership/mode/link/size admission: %j %j %j %j %j", async (uid, gid, mode, links, size, admitted) => {
    const result = runPolicy(await policy(), 'metadata_policy "$1" "$2" "$3" "$4" "$5" 0 0 1024; printf admitted', [String(uid), String(gid), String(mode), String(links), String(size)]);
    expect(result.status === 0).toBe(admitted);
    expect(result.stdout.includes("admitted")).toBe(admitted);
  });

  it("rejects a writable hosted-style parent and a noncanonical or linked source", async () => {
    const directory = await fixture();
    const file = path.join(directory, "source");
    const link = path.join(directory, "link");
    await writeFile(file, "fixture\n", { mode: 0o644 });
    await symlink(file, link);
    const ids = [String(process.getuid!()), String(process.getgid!())];
    const source = await policy();
    for (const target of [link, `${directory}/./source`]) {
      const result = runPolicy(source, 'inspect_metadata "$1" "$2" "$3" 1024; printf admitted', [target, ...ids]);
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stdout).failure.diagnostic.reason).toBe("path");
    }
    await chmod(directory, 0o777);
    const result = runPolicy(source, 'inspect_directory "$1" "$2" "$3"; printf admitted', [directory, ...ids]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).failure.diagnostic.reason).toBe("mode");
  });

  it.each(["archive-hash", "duplicate", "symlink", "hardlink", "identity", "rehash"])("rejects %s before Node execution", async (defect) => {
    const directory = await fixture();
    // Replace only the parser at the test boundary. No network, root ownership or Node execution.
    const source = (await policy()).replaceAll("/usr/bin/tar", "fixture_tar");
    const result = runPolicy(source, `
stage_root="$1"; defect="$2"; archive=fixture; node_version=22.23.2
select_node_archive
reads=0
inspect_file() {
  reads=$((reads + 1)); identity=original; file_hash="$archive_sha256"
  if [[ "$defect" = archive-hash || ( "$defect" = rehash && "$reads" = 2 ) ]]; then file_hash=wrong; fi
  if [[ "$defect" = identity && "$reads" = 2 ]]; then identity=changed; fi
}
fixture_tar() {
  printf parsed >> "$stage_root/parser-called"
  if [[ "$1" = --extract ]]; then printf payload; return; fi
  if [[ "$2" = --verbose ]]; then
    case "$defect" in symlink) printf 'lrwxrwxrwx member';; hardlink) printf 'hrwxr-xr-x member';; *) printf '%s' '-rwxr-xr-x member';; esac
  else
    printf '%s\\n' "$node_member"
    if [[ "$defect" = duplicate ]]; then printf '%s\\n' "$node_member"; fi
  fi
}
authenticate_node_archive
printf executed
`, [directory, defect]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("executed");
    if (defect === "archive-hash") {
      await expect(readFile(path.join(directory, "parser-called"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["source-identity", "source-hash", "copy-hash"])("rejects %s during the guarded copy", async (defect) => {
    const directory = await fixture();
    const source = (await policy()).replaceAll("/usr/bin/install", "fixture_install");
    const result = runPolicy(source, `
stage_root="$1"; defect="$2"; reads=0
declare -A source_paths source_hashes source_identities copy_hashes copy_identities
fixture_install() { :; }
inspect_file() {
  reads=$((reads + 1)); identity=original; file_hash=${"a".repeat(64)}
  if [[ "$defect" = source-identity && "$reads" = 2 ]]; then identity=changed; fi
  if [[ ( "$defect" = source-hash && "$reads" = 2 ) || ( "$defect" = copy-hash && "$reads" = 3 ) ]]; then file_hash=${"b".repeat(64)}; fi
}
copy_admitted_file node fixture 0 0 0555 1024
printf executed
`, [directory, defect]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("executed");
    expect(JSON.parse(result.stdout).failure.diagnostic.reason).toBe(defect === "copy-hash" ? "hash" : "identity");
  });

  it("bounds failure diagnostics even when their source values contain injected text", async () => {
    const injected = 'private/path\\"\nBASH_COMMAND=secret';
    const result = runPolicy(await policy(), 'stage="$1"; subject="$1"; reason="$1"; failure_json 999', [injected]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).failure.diagnostic).toEqual({ stage: "bootstrap", subject: "bootstrap", reason: "predicate", exitCode: 1 });
    expect(result.stdout).not.toContain("secret");
    expect(result.stdout.length).toBeLessThan(512);
  });

  it.each(["success", "replace", "unready", "changed-placeholder", "report-fails"])("preserves exit status with receipt outcome %s", async (outcome) => {
    const directory = await fixture();
    // The writer uses the real pinned directory, hashes, noclobber and atomic rename.
    // Simulate its already-admitted root metadata so ordinary unprivileged CI exercises it.
    const source = (await policy()).replaceAll("/usr/bin/stat", "fixture_stat");
    const result = runPolicy(source, `
receipt_dir="$1"; outcome="$2"
fixture_stat() {
  if [[ "$1" = -Lc && "$2" = '%u:%g:%a:%d:%i' ]]; then
    printf '0:0:755:%s\\n' "$(/usr/bin/stat -Lc '%d:%i' -- "$4")"
  else /usr/bin/stat "$@"; fi
}
printf '%s\\n' "$initial_receipt" > "$receipt_dir/secure-file-credential-proof.json"
exec {receipt_fd}< "$receipt_dir"
receipt_identity=$(/usr/bin/stat -c '%d:%i' -- "$receipt_dir")
receipt_ready=1
case "$outcome" in
  unready) receipt_ready=0 ;;
  changed-placeholder) printf changed >| "$receipt_dir/secure-file-credential-proof.json" ;;
  report-fails) printf occupied > "$receipt_dir/.staging-failure-$BASHPID.tmp" ;;
esac
stage=node-authentication subject=node-archive reason=hash
if [[ "$outcome" = success ]]; then exit 0; fi
exit 37
`, [directory, outcome]);
    expect(result.status).toBe(outcome === "success" ? 0 : 37);
    if (outcome === "success") expect(result.stdout).toBe("");
    else expect(JSON.parse(result.stdout).failure.diagnostic.exitCode).toBe(37);
    const receipt = await readFile(path.join(directory, "secure-file-credential-proof.json"), "utf8");
    if (outcome === "changed-placeholder") expect(receipt).toBe("changed");
    else expect(JSON.parse(receipt).failure.code).toBe(outcome === "replace" ? "STAGING_FAILED" : "PROOF_NOT_STARTED");
  });
});
