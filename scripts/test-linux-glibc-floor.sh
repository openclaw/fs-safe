#!/usr/bin/env bash
set -euo pipefail

# Use the official Node distribution already selected by setup-node, with Rocky's libc.
node_root="$(dirname "$(dirname "$(node -p 'process.execPath')")")"
docker build -t fs-safe-glibc-floor - <<'DOCKERFILE'
FROM rockylinux:8@sha256:9794037624aaa6212aeada1d28861ef5e0a935adaf93e4ef79837119f2a2d04c
RUN dnf install -y libstdc++ && dnf clean all
DOCKERFILE
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -v "$node_root:/node:ro" -w /work \
  fs-safe-glibc-floor bash -euc '
    export PATH=/node/bin:$PATH
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.28"
    getconf GNU_LIBC_VERSION
    node --version
    node scripts/native-smoke.mjs
    node scripts/native-mode-smoke.mjs require
    FS_SAFE_PAX_REQUIRE_NATIVE=1 node node_modules/vitest/vitest.mjs run --maxWorkers=1 \
      test/native-loader.test.ts test/native-load-fallback.test.ts \
      test/native-integration.test.ts test/native-unix-descriptor-admission.test.ts \
      test/root-move-noreplace.test.ts test/root-move-native-integration.test.ts
  '
