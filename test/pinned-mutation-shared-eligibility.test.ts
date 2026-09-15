import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import {
  preparePinnedWriteMutationAdmission,
  snapshotPinnedMutationPolicy,
} from "../src/pinned-mutation-admission.js";
import { checkedMutationDirectory } from "../src/pinned-mutation-observation.js";
import { realpathSync } from "../src/realpath.js";
import { resolveRootContext } from "../src/root-context.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function directoryObservation(pathname: string) {
  return checkedMutationDirectory(
    pathname,
    realpathSync.native(pathname),
    fsSync.lstatSync(pathname, { bigint: true }),
  );
}

describe.runIf(process.platform === "win32" && !process.versions.bun)(
  "Windows shared parent-walk eligibility",
  () => {
    it.each([
      ["mixed separators", "one/value"],
      ["traversal", String.raw`one\..\value`],
      ["trailing dot", String.raw`one\value.`],
      ["trailing space", String.raw`one\value `],
      ["reserved device", String.raw`one\CON.txt`],
      ["alternate data stream", String.raw`one\value:stream`],
      ["drive relative", String.raw`C:value`],
      ["short-name spelling", String.raw`PROGRA~1\value`],
      ["namespace path", String.raw`\\?\C:\outside\value`],
      ["UNC path", String.raw`\\server\share\value`],
    ])("deopts %s", async (_label, originalPath) => {
      const directory = await tempRoot("fs-safe-shared-walk-route-deopt-");
      const context = await resolveRootContext(directory);
      const safeTarget = path.join(directory, "safe", "value");
      const resolvedTargetPath = path.isAbsolute(originalPath) || originalPath.includes("..") ||
        /^[A-Za-z]:/.test(originalPath)
        ? safeTarget
        : path.resolve(directory, originalPath);
      const prepared = await preparePinnedWriteMutationAdmission({
        ...context,
        originalPath,
        resolvedTargetPath,
        defaultRelativeParentPath: "safe",
        policy: snapshotPinnedMutationPolicy(undefined, "reject")!,
        resolveCurrent: async () => ({ resolved: resolvedTargetPath }),
      });

      expect(prepared.mutationAdmission?.beginSharedParentWalk?.()).toBeUndefined();
    });

    it("deopts zero or non-bigint Root identity evidence", async () => {
      const directory = await tempRoot("fs-safe-shared-walk-identity-deopt-");
      const context = await resolveRootContext(directory);
      const originalPath = String.raw`one\value`;
      const resolvedTargetPath = path.join(directory, originalPath);

      for (const rootIdentity of [
        { dev: 0n, ino: context.rootIdentity.ino as bigint },
        { dev: Number(context.rootIdentity.dev), ino: Number(context.rootIdentity.ino) },
      ]) {
        const prepared = await preparePinnedWriteMutationAdmission({
          ...context,
          rootIdentity,
          originalPath,
          resolvedTargetPath,
          defaultRelativeParentPath: "one",
          policy: snapshotPinnedMutationPolicy(undefined, "reject")!,
          resolveCurrent: async () => ({ resolved: resolvedTargetPath }),
        });
        expect(prepared.mutationAdmission?.beginSharedParentWalk?.()).toBeUndefined();
      }
    });

    it("deopts a case-folded selected route", async () => {
      const directory = await tempRoot("fs-safe-shared-walk-case-deopt-");
      const context = await resolveRootContext(directory);
      const selectedParent = path.join(directory, "CaseParent");
      await fs.mkdir(selectedParent);
      const resolvedTargetPath = path.join(selectedParent, "value");
      const prepared = await preparePinnedWriteMutationAdmission({
        ...context,
        originalPath: String.raw`caseparent\value`,
        resolvedTargetPath,
        defaultRelativeParentPath: "CaseParent",
        policy: snapshotPinnedMutationPolicy(undefined, "reject")!,
        resolveCurrent: async () => ({ resolved: resolvedTargetPath }),
      });
      expect(prepared.mutationAdmission?.beginSharedParentWalk?.()).toBeUndefined();
    });

    it("expires shared evidence on configuration change, disposal, and foreign receipt", async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-walk-expiry-");
      const context = await resolveRootContext(directory);
      const originalPath = String.raw`one\value`;
      const target = path.join(directory, originalPath);
      const prepared = await preparePinnedWriteMutationAdmission({
        ...context,
        originalPath,
        resolvedTargetPath: target,
        defaultRelativeParentPath: "one",
        policy: snapshotPinnedMutationPolicy(undefined, "reject")!,
        resolveCurrent: async () => ({ resolved: target }),
      });
      const request = Object.freeze({
        targetPath: target,
        mutationPath: path.join(directory, "one"),
        phase: "parent-create" as const,
      });

      const changed = prepared.mutationAdmission?.beginSharedParentWalk?.();
      expect(changed).toBeDefined();
      configureFsSafeNative({ mode: "auto" });
      await expect(changed!.authorize(request)).resolves.toBeUndefined();
      changed!.dispose();
      expect(changed!.tryAuthorizeAtParent(request, directoryObservation(directory)))
        .toBeUndefined();

      configureFsSafeNative({ mode: "off" });
      const foreign = prepared.mutationAdmission?.beginSharedParentWalk?.();
      const admitted = await foreign!.authorize(request);
      expect(admitted).toBeDefined();
      const directoryReceipt = directoryObservation(directory);
      expect(foreign!.advanceCreatedDirectory(Object.freeze({
        admission: Object.freeze({}),
        parent: directoryReceipt,
        child: directoryReceipt,
      }))).toBeUndefined();
      foreign!.dispose();
    });
  },
);

describe.runIf(process.platform !== "win32" && !process.versions.bun)(
  "POSIX shared parent-walk eligibility",
  () => {
    it.each([
      ["backslash spelling", String.raw`one\value`],
      ["traversal", "one/../value"],
      ["empty segment", "one//value"],
      ["non-ordinary segment", "one/value with space"],
    ])("deopts %s", async (_label, originalPath) => {
      const directory = await tempRoot("fs-safe-shared-posix-route-deopt-");
      const context = await resolveRootContext(directory);
      const resolvedTargetPath = path.resolve(directory, originalPath);
      const prepared = await preparePinnedWriteMutationAdmission({
        ...context,
        originalPath,
        resolvedTargetPath,
        defaultRelativeParentPath: path.relative(directory, path.dirname(resolvedTargetPath)),
        policy: snapshotPinnedMutationPolicy(undefined, "reject")!,
        resolveCurrent: async () => ({ resolved: resolvedTargetPath }),
      });

      expect(prepared.mutationAdmission?.beginSharedParentWalk?.()).toBeUndefined();
    });

    it("accepts an ordinary exact route with an observed in-root deny entry", async () => {
      const directory = await tempRoot("fs-safe-shared-posix-route-eligible-");
      const context = await resolveRootContext(directory);
      const target = path.join(directory, "one", "value");
      const prepared = await preparePinnedWriteMutationAdmission({
        ...context,
        originalPath: "one/value",
        resolvedTargetPath: target,
        defaultRelativeParentPath: "one",
        policy: snapshotPinnedMutationPolicy(
          { prefixes: [path.join(directory, "denied")] },
          "reject",
        )!,
        resolveCurrent: async () => ({ resolved: target }),
      });

      const session = prepared.mutationAdmission?.beginSharedParentWalk?.();
      expect(session).toBeDefined();
      session?.dispose();
    });

    it("deopts zero identity and outside-root deny observations", async () => {
      const directory = await tempRoot("fs-safe-shared-posix-evidence-deopt-");
      const context = await resolveRootContext(directory);
      const target = path.join(directory, "one", "value");
      const outside = path.join(path.dirname(directory), "outside", "denied");

      for (const candidate of [
        {
          rootIdentity: { dev: 0n, ino: context.rootIdentity.ino as bigint },
          policy: snapshotPinnedMutationPolicy(undefined, "reject")!,
        },
        {
          rootIdentity: context.rootIdentity,
          policy: snapshotPinnedMutationPolicy(
            { prefixes: [outside] },
            "reject",
          )!,
        },
      ]) {
        const prepared = await preparePinnedWriteMutationAdmission({
          ...context,
          ...candidate,
          originalPath: "one/value",
          resolvedTargetPath: target,
          defaultRelativeParentPath: "one",
          resolveCurrent: async () => ({ resolved: target }),
        });
        expect(prepared.mutationAdmission?.beginSharedParentWalk?.()).toBeUndefined();
      }
    });
  },
);
