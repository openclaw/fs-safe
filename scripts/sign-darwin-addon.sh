#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

addon="${1:?usage: sign-darwin-addon.sh path/to/addon.node}"
: "${MACOS_SIGNING_P12:?missing MACOS_SIGNING_P12}"
: "${MACOS_SIGNING_P12_PASSWORD:?missing MACOS_SIGNING_P12_PASSWORD}"
: "${ASC_KEY_ID:?missing ASC_KEY_ID}"
: "${ASC_ISSUER_ID:?missing ASC_ISSUER_ID}"
: "${ASC_PRIVATE_KEY_P8:?missing ASC_PRIVATE_KEY_P8}"
identity='Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)'
team='FWJYW4S8P8'
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fs-safe-sign.XXXXXX")"
keychain="$work/signing.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

printf '%s' "$MACOS_SIGNING_P12" | base64 --decode > "$work/certificate.p12"
printf '%s' "$ASC_PRIVATE_KEY_P8" > "$work/AuthKey.p8"
password="$(openssl rand -hex 24)"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -P "$MACOS_SIGNING_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
unset password MACOS_SIGNING_P12 MACOS_SIGNING_P12_PASSWORD

codesign --force --options runtime --timestamp --keychain "$keychain" --sign "$identity" "$addon"
codesign --verify --strict "$addon"
# A .node library is not a launchable app: spctl is not its signature authority.
verify_identity() {
  local details
  details="$(codesign -dv --verbose=4 "$addon" 2>&1)"
  printf '%s\n' "$details"
  printf '%s\n' "$details" | grep -Fx "Authority=$identity"
  printf '%s\n' "$details" | grep -Fx "TeamIdentifier=$team"
  printf '%s\n' "$details" | grep -Eq '^CodeDirectory .*flags=.*\(.*runtime.*\)'
  printf '%s\n' "$details" | grep -E '^Timestamp='
}
verify_identity

ditto -c -k --keepParent "$addon" "$work/addon.zip"
proof="${addon%.node}.notarization.json"
log="${addon%.node}.notarization-log.json"
xcrun notarytool submit "$work/addon.zip" --key "$work/AuthKey.p8" \
  --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait --timeout 20m \
  --output-format json > "$work/submission.json"
submission_id="$(node -e 'const p=require(process.argv[1]); if (!/^[a-f0-9-]{36}$/i.test(p.id)) throw Error("missing notary submission ID"); process.stdout.write(p.id)' "$work/submission.json")"
xcrun notarytool log "$submission_id" --key "$work/AuthKey.p8" \
  --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" "$log"
node - "$addon" "$work/addon.zip" "$work/submission.json" "$log" "$proof" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [addon, archive, submissionPath, logPath, proofPath] = process.argv.slice(2);
const submission = JSON.parse(fs.readFileSync(submissionPath, 'utf8'));
const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
const sha256 = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
if (submission.status !== 'Accepted' || log.status !== 'Accepted' || log.statusCode !== 0 || log.jobId !== submission.id || log.sha256 !== sha256(archive)) {
  throw new Error('Apple notarization did not accept the submitted addon archive');
}
fs.writeFileSync(proofPath, JSON.stringify({ ...submission, addon: require('node:path').basename(addon), sha256: sha256(addon), archiveSha256: log.sha256, teamIdentifier: 'FWJYW4S8P8' }, null, 2) + '\n');
console.log(`Notarization accepted: ${submission.id}`);
NODE
# Bare .node files cannot be stapled; Apple serves their tickets online.
codesign --verify --strict "$addon"
verify_identity
