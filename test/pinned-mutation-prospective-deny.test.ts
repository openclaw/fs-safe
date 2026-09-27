import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as caseProbe from "../src/path-case.js";
import { preparePinnedWriteMutationAdmission, snapshotPinnedMutationPolicy } from "../src/pinned-mutation-admission.js";
import { resolveRootContext } from "../src/root-context.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32" || !!process.versions.bun)(
  "cached parent admission rechecks prospective aliases when sensitivity becomes unknown", async () => {
    const directory = await tempRoot("fs-safe-cached-prospective-");
    const context = await resolveRootContext(directory);
    const target = path.join(directory, "case");
    const resolveCurrent = vi.fn(async () => ({ resolved: target }));
    const probe = vi.spyOn(caseProbe, "probePathCaseInsensitiveSync").mockReturnValue(false);
    const prepared = await preparePinnedWriteMutationAdmission({
      ...context,
      originalPath: "case",
      resolvedTargetPath: target,
      defaultRelativeParentPath: ".",
      policy: snapshotPinnedMutationPolicy({ paths: [path.join(directory, "Case")] }, "reject"),
      resolveCurrent,
    });
    const admission = prepared.mutationAdmission!;
    admission.beginParentWalk?.();
    const request = { targetPath: target, mutationPath: target, phase: "parent" as const };
    await admission.authorize(request);
    expect(resolveCurrent).toHaveBeenCalledTimes(1);
    probe.mockReturnValue(undefined);
    await expect(admission.authorize(request)).rejects.toMatchObject({ code: "denied-path" });
    expect(resolveCurrent).toHaveBeenCalledTimes(1);
  },
);
