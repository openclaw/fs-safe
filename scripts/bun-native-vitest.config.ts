import config from "./bun-vitest.config.js";

// The full diagnostic suite also tests explicitly disabled/missing addons.
// Qualify Bun's supported native path and its security/publication siblings here;
// keep the unchanged Node fallback matrix in the ordinary check jobs.
export default {
  ...config,
  test: {
    ...config.test,
    include: [
      "test/realpath.test.ts",
      "test/relative-publication.test.ts",
      "test/native-integration.test.ts",
      "test/windows-native-fd-bridge.test.ts",
      "test/native-loader.test.ts",
      "test/native-write-containment.test.ts",
      "test/native-staging-regression.test.ts",
      "test/read-boundary-bypass.test.ts",
      "test/write-boundary-bypass.test.ts",
      "test/adversarial-boundary-payloads.test.ts",
      "test/root-copy-*.test.ts",
      "test/root-parent-symlink-policy.test.ts",
      "test/root-mutation-*.test.ts",
      "test/native-mutation-policy-integration.test.ts",
      "test/pinned-mutation-fast-path.test.ts",
      "test/root-shared-js-bun-deoptimization.test.ts",
      "test/file-lock*.test.ts",
      "test/clone.test.ts",
      "test/copy-tree.test.ts",
      "test/file-hash.test.ts",
      "test/file-hash-identity.test.ts",
      "test/native-archive-equivalence.test.ts",
      "test/archive-native-mode-admission.test.ts",
    ],
  },
};
