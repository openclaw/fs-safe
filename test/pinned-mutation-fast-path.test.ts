import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMutationNotDenied } from "../src/deny-mutations.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { runPinnedWriteNative } from "../src/native-pinned-write.js";
import {
  preparePinnedWriteMutationAdmission,
  snapshotPinnedMutationPolicy,
} from "../src/pinned-mutation-admission.js";
import {
  checkedMutationDirectory,
  mutationDirectoryObservationCurrent,
} from "../src/pinned-mutation-observation.js";
import { realpathSync } from "../src/realpath.js";
import { resolvePathInRoot, resolveRootContext } from "../src/root-context.js";
import { mutationSymlinkResolution } from "../src/root-symlink-policy.js";
import { root, type Root, type RootWriteOptions } from "../src/root.js";
import {
  assertPolicyStagedDirectoryCurrent,
  describePolicyStagedDirectory,
} from "../src/staged-directory.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import type { PinnedWriteMutationAdmission } from "../src/pinned-write.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
if (process.platform !== "win32" && !process.versions.bun) {
  try {
    __loadBundledNativeForTest();
    nativeAvailable = true;
  } catch (error) {
    if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
  }
}

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

async function prepareAdmission(directory: string, originalPath: string): Promise<{
  admission: PinnedWriteMutationAdmission;
  resolveCurrent: ReturnType<typeof vi.fn>;
  target: string;
}> {
  const context = await resolveRootContext(directory);
  const policy = snapshotPinnedMutationPolicy(undefined, "reject")!;
  const resolveCurrent = vi.fn(async () => {
    const current = await resolvePathInRoot(context, originalPath, {
      aliasErrorCode: "path-alias",
      rejectAmbiguousParents: true,
      ...mutationSymlinkResolution("reject"),
    });
    await assertMutationNotDenied(current.resolved, policy.denyMutations);
    return current;
  });
  const initial = await resolveCurrent();
  const prepared = await preparePinnedWriteMutationAdmission({
    ...context,
    originalPath,
    resolvedTargetPath: initial.resolved,
    defaultRelativeParentPath: path.posix.dirname(originalPath),
    policy,
    resolveCurrent,
  });
  prepared.mutationAdmission!.beginParentWalk?.();
  resolveCurrent.mockClear();
  return { admission: prepared.mutationAdmission!, resolveCurrent, target: initial.resolved };
}

describe.runIf(process.platform !== "win32" && !process.versions.bun)(
  "bounded synchronous mutation authorization",
  () => {
    it.each([1, 8, 32])(
      "shares same-phase pathname checks at depth %s without retaining live evidence",
      async (depth) => {
        const directory = await tempRoot(`fs-safe-policy-budget-${depth}-`);
        const parts = Array.from({ length: depth }, (_, index) => `level-${index}`);
        const prepared = await prepareAdmission(directory, [...parts, "value"].join("/"));
        await prepared.admission.authorize(Object.freeze({
          targetPath: prepared.target,
          mutationPath: prepared.target,
          phase: "parent" as const,
        }));
        expect(prepared.resolveCurrent).toHaveBeenCalledTimes(1);

        let parentPath = directory;
        let parent = directoryObservation(parentPath);
        const originalNative = fsSync.realpathSync.native;
        const jsRealpath = vi.spyOn(fsSync, "realpathSync");
        const nativeRealpath = vi.spyOn(realpathSync, "native")
          .mockImplementation((input) => originalNative(input));
        const lstat = vi.spyOn(fsSync, "lstatSync");
        const fstat = vi.spyOn(fsSync, "fstatSync");

        for (const part of parts) {
          const childPath = path.join(parentPath, part);
          const createReceipt = prepared.admission.tryAuthorizeAtParent?.(
            Object.freeze({
              targetPath: prepared.target,
              mutationPath: childPath,
              phase: "parent-create" as const,
            }),
            parent,
          );
          expect(createReceipt).toBeTypeOf("object");
          expect(createReceipt).not.toBeInstanceOf(Promise);
          expect(mutationDirectoryObservationCurrent(parent)).toBe(true);
          await fs.mkdir(childPath);
          const parentAfter = directoryObservation(parentPath);
          const childFd = fsSync.openSync(
            childPath,
            fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0),
          );
          const child = describePolicyStagedDirectory(childFd, childPath).observation;
          const completed = prepared.admission.advanceCreatedDirectory?.(
            Object.freeze({ admission: createReceipt!, parent: parentAfter, child }),
          );
          fsSync.closeSync(childFd);
          expect(completed).toBeTypeOf("object");
          expect(completed).not.toBeInstanceOf(Promise);
          parentPath = childPath;
          parent = child;
        }

        expect(lstat).toHaveBeenCalledTimes(11 * depth - 2);
        expect(nativeRealpath).toHaveBeenCalledTimes(9 * depth - 2);
        expect(jsRealpath).not.toHaveBeenCalled();
        expect(fstat).toHaveBeenCalledTimes(depth);
        expect(prepared.resolveCurrent).toHaveBeenCalledTimes(1);
      },
    );

    it.runIf(nativeAvailable).each([1, 8, 32])(
      "the real native walker bounds JavaScript pathname observations at depth %s",
      async (depth) => {
        configureFsSafeNative({ mode: "require" });
        const directory = await tempRoot(`fs-safe-policy-native-budget-${depth}-`);
        const parts = Array.from({ length: depth }, (_, index) => `level-${index}`);
        const relativeParentPath = parts.join("/");
        const prepared = await prepareAdmission(
          directory,
          `${relativeParentPath}/value`,
        );
        const binding = __loadBundledNativeForTest();
        const stopBeforeStage = new Error("stop before native staging");
        const candidate: NativeBinding = {
          ...binding,
          createStagedFile() {
            throw stopBeforeStage;
          },
        };
        const directoryObservations = candidate.observeDirectoryFd
          ? vi.spyOn(candidate, "observeDirectoryFd") : undefined;

        const originalNative = fsSync.realpathSync.native;
        const jsRealpath = vi.spyOn(fsSync, "realpathSync");
        const nativeRealpath = vi.spyOn(realpathSync, "native")
          .mockImplementation((input) => originalNative(input));
        const lstat = vi.spyOn(fsSync, "lstatSync");
        const fstat = vi.spyOn(fsSync, "fstatSync");
        let admissionReset = false;
        const admission: PinnedWriteMutationAdmission = Object.freeze({
          rejectParentSymlinks: prepared.admission.rejectParentSymlinks,
          beginParentWalk: () => prepared.admission.beginParentWalk?.(),
          tryAuthorizeAtParent: (request, parent) =>
            prepared.admission.tryAuthorizeAtParent?.(request, parent),
          async authorize(request) {
            const receipt = await prepared.admission.authorize(request);
            if (!admissionReset) {
              admissionReset = true;
              lstat.mockClear();
              nativeRealpath.mockClear();
              jsRealpath.mockClear();
              fstat.mockClear();
              directoryObservations?.mockClear();
            }
            return receipt;
          },
          advanceCreatedDirectory: (receipt) =>
            prepared.admission.advanceCreatedDirectory?.(receipt),
        });

        await expect(runPinnedWriteNative(candidate, {
          rootPath: directory,
          relativeParentPath,
          basename: "value",
          mkdir: true,
          mode: 0o600,
          sync: false,
          input: { kind: "buffer", data: "payload" },
          mutationAdmission: admission,
        })).rejects.toBe(stopBeforeStage);

        expect(admissionReset).toBe(true);
        expect(lstat).toHaveBeenCalledTimes(directoryObservations ? 4 * depth - 1 : 11 * depth);
        expect(nativeRealpath).toHaveBeenCalledTimes(directoryObservations ? 2 * depth - 2 : 9 * depth - 1);
        if (directoryObservations) expect(directoryObservations).toHaveBeenCalledTimes(6 * depth + 1);
        expect(jsRealpath).toHaveBeenCalledTimes(1);
        expect(fstat).toHaveBeenCalledTimes(depth);
      },
    );

    it("deoptimizes a parent mismatch to ordered admission without creating or staging", async () => {
      const directory = await tempRoot("fs-safe-policy-parent-deopt-");
      const other = path.join(directory, "other");
      await fs.mkdir(other);
      const prepared = await prepareAdmission(directory, "one/two/value");
      await prepared.admission.authorize({
        targetPath: prepared.target,
        mutationPath: prepared.target,
        phase: "parent",
      });
      const next = path.join(directory, "one");
      expect(prepared.admission.tryAuthorizeAtParent?.({
        targetPath: prepared.target,
        mutationPath: next,
        phase: "parent-create",
      }, directoryObservation(other))).toBeUndefined();
      await prepared.admission.authorize({
        targetPath: prepared.target,
        mutationPath: next,
        phase: "parent-create",
      });
      expect(prepared.resolveCurrent).toHaveBeenCalledTimes(2);
      await expect(fs.lstat(next)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(directory)).filter((entry) => entry.startsWith(".fs-safe-")))
        .toEqual([]);
    });

    it("deoptimizes a link-count or native configuration change before mkdir", async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-policy-current-deopt-");
      const prepared = await prepareAdmission(directory, "one/value");
      await prepared.admission.authorize({
        targetPath: prepared.target,
        mutationPath: prepared.target,
        phase: "parent",
      });
      const parent = directoryObservation(directory);
      await fs.mkdir(path.join(directory, "unrelated"));
      expect(prepared.admission.tryAuthorizeAtParent?.({
        targetPath: prepared.target,
        mutationPath: path.join(directory, "one"),
        phase: "parent-create",
      }, parent)).toBeUndefined();
      configureFsSafeNative({ mode: "auto" });
      expect(prepared.admission.tryAuthorizeAtParent?.({
        targetPath: prepared.target,
        mutationPath: path.join(directory, "one"),
        phase: "parent-create",
      }, directoryObservation(directory))).toBeUndefined();
      await expect(fs.lstat(path.join(directory, "one"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["directory", "symlink", "file"] as const)(
      "does not reuse a root observation after a %s replacement",
      async (replacement) => {
        const base = await tempRoot("fs-safe-policy-root-replace-");
        const directory = path.join(base, "root");
        const saved = path.join(base, "saved");
        await fs.mkdir(directory);
        const prepared = await prepareAdmission(directory, "one/value");
        await prepared.admission.authorize({
          targetPath: prepared.target,
          mutationPath: prepared.target,
          phase: "parent",
        });
        const parent = directoryObservation(directory);
        await fs.rename(directory, saved);
        if (replacement === "directory") await fs.mkdir(directory);
        else if (replacement === "symlink") await fs.symlink(saved, directory, "dir");
        else await fs.writeFile(directory, "not a directory");
        expect(prepared.admission.tryAuthorizeAtParent?.({
          targetPath: prepared.target,
          mutationPath: path.join(directory, "one"),
          phase: "parent-create",
        }, parent)).toBeUndefined();
        await expect(fs.lstat(path.join(saved, "one"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  },
);

describe.runIf(process.platform !== "win32" && !process.versions.bun)(
  "policy POSIX descriptor capture",
  () => {
    it("uses exactly 1F + 3L + 3Rn + 0Rj through its post-admission fence", async () => {
      const directory = await tempRoot("fs-safe-policy-descriptor-");
      const fd = fsSync.openSync(
        directory,
        fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0),
      );
      try {
        const originalNative = fsSync.realpathSync.native;
        const jsRealpath = vi.spyOn(fsSync, "realpathSync");
        const nativeRealpath = vi.spyOn(realpathSync, "native")
          .mockImplementation((input) => originalNative(input));
        const lstat = vi.spyOn(fsSync, "lstatSync");
        const fstat = vi.spyOn(fsSync, "fstatSync");
        const captured = describePolicyStagedDirectory(fd, directory);
        assertPolicyStagedDirectoryCurrent(captured);
        expect(fstat).toHaveBeenCalledTimes(1);
        expect(lstat).toHaveBeenCalledTimes(3);
        expect(nativeRealpath).toHaveBeenCalledTimes(3);
        expect(jsRealpath).not.toHaveBeenCalled();
        if (process.platform === "darwin") {
          expect(captured.directory.realPath).toBe(directory);
        }
      } finally {
        fsSync.closeSync(fd);
      }
    });
  },
);

async function runCompleteParentOperation(
  safe: Root,
  operation: "write" | "create" | "copyIn" | "staged-stream",
  relativePath: string,
  source: string,
  options: RootWriteOptions,
): Promise<void> {
  if (operation === "copyIn") await safe.copyIn(relativePath, source, options);
  else if (operation === "create") await safe.create(relativePath, "payload", options);
  else if (operation === "staged-stream") {
    await safe.create(relativePath, (async function* () { yield Buffer.from("payload"); })(), options);
  } else await safe.write(relativePath, "payload", options);
}

describe.runIf(process.platform !== "win32" && !process.versions.bun)(
  "fallback complete-parent fast path",
  () => {
    it.each(
      (["write", "create", "copyIn", "staged-stream"] as const).flatMap((operation) =>
        [true, false].map((mkdir) => ({ operation, mkdir }))),
    )("skips the component walker for $operation (mkdir=$mkdir)", async ({ operation, mkdir }) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-policy-complete-parent-");
      const parent = path.join(directory, "existing", "nested");
      const source = path.join(directory, "source");
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(source, "payload");
      let componentHooks = 0;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation(operationName) {
          if (operationName === "mkdir") componentHooks += 1;
        },
      });
      const safe = await root(directory);
      const relativePath = `existing/nested/${operation}-${String(mkdir)}`;
      await runCompleteParentOperation(safe, operation, relativePath, source, {
        mkdir,
        durable: false,
        mutationSymlinks: "reject",
        denyMutations: { paths: [parent] },
      });
      expect(componentHooks).toBe(0);
      expect(await fs.readFile(path.join(directory, relativePath), "utf8")).toBe("payload");
    });
  },
);

describe("fallback exact guards on receipt-ineligible routes", () => {
  const complexRelativePath = process.platform === "win32" || process.versions.bun
    ? "nested/value"
    : "./nested/value";

  it("creates missing parents without degrading exact observations to invalid-path", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-policy-complex-success-");
    const safe = await root(directory);
    await safe.write(complexRelativePath, "payload", {
      durable: false,
      mutationSymlinks: "reject",
    });
    expect(await fs.readFile(path.join(directory, "nested/value"), "utf8")).toBe("payload");
  });

  it("applies an exact missing-parent deny before mkdir", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-policy-complex-deny-");
    const deniedParent = path.join(directory, "nested");
    const safe = await root(directory);
    await expect(safe.write(complexRelativePath, "payload", {
      durable: false,
      denyMutations: { paths: [deniedParent] },
    })).rejects.toMatchObject({ code: "denied-path" });
    await expect(fs.lstat(deniedParent)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
