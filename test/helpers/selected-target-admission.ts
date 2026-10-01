import fs, { type FileHandle } from "node:fs/promises";
import { expect, vi } from "vitest";
import * as writeAdmission from "../../src/root-write-admission.js";
import { __setFsSafeTestHooksForTest } from "../../src/test-hooks.js";

export function captureOpenedHandles() {
  const handles: FileHandle[] = [];
  const realOpen = fs.open.bind(fs);
  const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    handles.push(handle);
    return handle;
  });
  return { handles, open };
}

type SelectedTargetScenario =
  | { boundary: "authorization"; selected: string; deniedAlias: string }
  | { boundary: "binding"; alias: string; retarget: string };

export async function runSelectedTargetScenario(
  scenario: SelectedTargetScenario,
  run: (callback: () => void) => Promise<void>,
) {
  const { handles, open } = captureOpenedHandles();
  const callback = vi.fn();
  let admissions = 0;
  let policyRetargeted = false;
  let selectedAdmissionChecks = 0;
  if (scenario.boundary === "authorization") {
    const { selected, deniedAlias } = scenario;
    const resolveTarget = writeAdmission.resolveGuardedWriteTargetInRoot;
    vi.spyOn(writeAdmission, "resolveGuardedWriteTargetInRoot").mockImplementation(
      async (...args) => {
        const guarded = await resolveTarget(...args);
        const admission = guarded.selectedTargetAdmission!;
        expect(admission).toBeDefined();
        const authorize = admission.authorize.bind(admission);
        return {
          ...guarded,
          selectedTargetAdmission: Object.freeze({
            ...admission,
            async authorize(selectedPath: string) {
              selectedAdmissionChecks += 1;
              expect(selectedPath).toBe(selected);
              expect(policyRetargeted).toBe(false);
              policyRetargeted = true;
              await fs.unlink(deniedAlias);
              await fs.symlink(selected, deniedAlias, "file");
              await authorize(selectedPath);
            },
          }),
        };
      },
    );
    __setFsSafeTestHooksForTest({
      beforePinnedWriteParentAdmission() {
        admissions += 1;
        expect(policyRetargeted).toBe(false);
      },
    });
  } else {
    __setFsSafeTestHooksForTest({
      async beforePinnedWriteParentAdmission() {
        if (++admissions !== 2) return;
        await fs.unlink(scenario.alias);
        await fs.symlink(scenario.retarget, scenario.alias, "file");
      },
    });
  }
  await expect(run(callback)).rejects.toMatchObject({
    code: scenario.boundary === "authorization" ? "denied-path" : "path-mismatch",
  });
  return { admissions, policyRetargeted, selectedAdmissionChecks, callback, handles, open };
}
