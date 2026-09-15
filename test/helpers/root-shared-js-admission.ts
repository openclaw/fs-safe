import { vi } from "vitest";
import * as writeAdmission from "../../src/root-write-admission.js";

export type MutationAdmissionRequest = Readonly<{
  targetPath: string;
  mutationPath: string;
  phase: "parent" | "parent-create";
}>;

export function observeMutationAuthorizations(
  hooks: Readonly<{
    beforeAuthorize?: (request: MutationAdmissionRequest) => Promise<void> | void;
    afterAuthorize?: (request: MutationAdmissionRequest) => Promise<void> | void;
  }> = {},
): Map<string, number> {
  const counts = new Map<string, number>();
  const resolveTarget = writeAdmission.resolveGuardedWriteTargetInRoot;
  vi.spyOn(writeAdmission, "resolveGuardedWriteTargetInRoot").mockImplementation(
    async (...args) => {
      const guarded = await resolveTarget(...args);
      const admission = guarded.mutationAdmission;
      if (!admission) return guarded;
      return {
        ...guarded,
        mutationAdmission: Object.freeze({
          ...admission,
          async authorize(request: MutationAdmissionRequest) {
            counts.set(request.targetPath, (counts.get(request.targetPath) ?? 0) + 1);
            await hooks.beforeAuthorize?.(request);
            const receipt = await admission.authorize(request);
            await hooks.afterAuthorize?.(request);
            return receipt;
          },
        }),
      };
    },
  );
  return counts;
}
