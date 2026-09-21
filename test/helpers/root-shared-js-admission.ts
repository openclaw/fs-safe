import { vi } from "vitest";
import type { MutationDirectoryObservation } from "../../src/pinned-mutation-observation.js";
import type { PinnedCreatedDirectoryReceipt } from "../../src/pinned-write-types.js";
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
    afterSharedProbe?: (request: MutationAdmissionRequest, reused: boolean) => void;
    beforeSharedAuthorize?: (request: MutationAdmissionRequest) => void;
    afterSharedAdvance?: (advanced: boolean) => void;
  }> = {},
): Map<string, number> {
  const counts = new Map<string, number>();
  const resolveTarget = writeAdmission.resolveGuardedWriteTargetInRoot;
  vi.spyOn(writeAdmission, "resolveGuardedWriteTargetInRoot").mockImplementation(
    async (...args) => {
      const guarded = await resolveTarget(...args);
      const admission = guarded.mutationAdmission;
      if (!admission) return guarded;
      const beginSharedParentWalk = admission.beginSharedParentWalk;
      return {
        ...guarded,
        mutationAdmission: Object.freeze({
          ...admission,
          beginSharedParentWalk: beginSharedParentWalk ? () => {
            const session = beginSharedParentWalk();
            if (!session) return undefined;
            return Object.freeze({
              ...session,
              tryAuthorizeAtParent(
                request: MutationAdmissionRequest,
                parent: MutationDirectoryObservation,
              ) {
                const authorization = session.tryAuthorizeAtParent(request, parent);
                hooks.afterSharedProbe?.(request, authorization !== undefined);
                return authorization;
              },
              async authorize(request: MutationAdmissionRequest) {
                hooks.beforeSharedAuthorize?.(request);
                return await session.authorize(request);
              },
              advanceCreatedDirectory(receipt: PinnedCreatedDirectoryReceipt) {
                const authorization = session.advanceCreatedDirectory(receipt);
                hooks.afterSharedAdvance?.(authorization !== undefined);
                return authorization;
              },
            });
          } : undefined,
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
