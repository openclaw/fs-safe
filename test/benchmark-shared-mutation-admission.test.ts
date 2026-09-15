import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROOT_WRITE_MUTATION_ADMISSION_NAMES,
  registerSharedMutationAdmission,
  sharedMutationAdmissionDescriptors,
} from "../benchmarks/shared-mutation-admission.mjs";

function operationCounts(platform: string) {
  const descriptors = sharedMutationAdmissionDescriptors(platform);
  return Object.fromEntries([
    "Root.openWritable", "Root.append", "Root.mkdir", "Root.write", "Root.create",
  ].map((operation) => [operation, descriptors.filter((row) => row.operation === operation).length]));
}

describe("shared JavaScript mutation-admission benchmark", () => {
  it("retains the six focused Root.write policy rows", () => {
    expect(ROOT_WRITE_MUTATION_ADMISSION_NAMES).toEqual([
      "Root.write/mutation-admission/existing/depth=1",
      "Root.write/mutation-admission/mkdir/depth=1",
      "Root.write/mutation-admission/existing/depth=8",
      "Root.write/mutation-admission/mkdir/depth=8",
      "Root.write/mutation-admission/existing/depth=32",
      "Root.write/mutation-admission/mkdir/depth=32",
    ]);
    expect(ROOT_WRITE_MUTATION_ADMISSION_NAMES.filter((name) =>
      name.includes("Root.write/mutation-admission"))).toHaveLength(6);
  });

  it("keeps the ordered 60 portable and 96 Windows rows without duplicates", () => {
    const portable = sharedMutationAdmissionDescriptors("linux");
    const windows = sharedMutationAdmissionDescriptors("win32");
    expect(portable).toHaveLength(60);
    expect(windows).toHaveLength(96);
    expect(portable.filter(({ name }) => name.includes("shared-js-mutation-admission")))
      .toHaveLength(60);
    expect(windows.filter(({ name }) => name.includes("shared-js-mutation-admission")))
      .toHaveLength(96);
    expect(operationCounts("linux")).toEqual({
      "Root.openWritable": 36,
      "Root.append": 12,
      "Root.mkdir": 12,
      "Root.write": 0,
      "Root.create": 0,
    });
    expect(operationCounts("win32")).toEqual({
      "Root.openWritable": 36,
      "Root.append": 12,
      "Root.mkdir": 12,
      "Root.write": 24,
      "Root.create": 12,
    });
    expect(new Set(windows.map(({ name }) => name)).size).toBe(96);
    expect(windows.slice(0, 60)).toEqual(portable);
    for (let index = 0; index < windows.length; index += 2) {
      expect(windows[index].policy).toBe("none");
      expect(windows[index + 1].policy).toBe("enabled");
      expect(windows[index + 1].name)
        .toBe(windows[index].name.replace("policy=none", "policy=enabled"));
    }
    expect(windows[0].name)
      .toBe("Root.openWritable/shared-js-mutation-admission/mode=update/existing-target/policy=none/depth=1");
    expect(windows.at(-1)?.name)
      .toBe("Root.create/shared-js-mutation-admission/mode=exclusive/missing-parent/policy=enabled/depth=32");
  });

  it("preserves depth/layout fixtures, policy options, divisor, close, reset, and cleanup", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-benchmark-contract-"));
    let invoked: { relative: string; options: Record<string, unknown> } | undefined;
    let closed = false;
    const root = {
      openWritable: async (relative: string, options: Record<string, unknown>) => {
        invoked = { relative, options };
        return { handle: { close: async () => { closed = true; } } };
      },
    };
    type RowOptions = {
      divisor: number;
      before: () => void;
      verify: (result: unknown) => void;
      after: (result: unknown) => Promise<void>;
    };
    const rows: Array<{
      name: string;
      run: () => Promise<unknown>;
      options: RowOptions;
    }> = [];
    try {
      registerSharedMutationAdmission({
        root,
        workspace,
        platform: "linux",
        register: (name: string, run: () => Promise<unknown>, options: RowOptions) =>
          rows.push({ name, run, options }),
      });
      const row = rows.find(({ name }) => name ===
        "Root.openWritable/shared-js-mutation-admission/mode=update/existing-target/policy=enabled/depth=8")!;
      expect(row.options.divisor).toBe(10);
      row.options.before();
      const result = await row.run();
      expect(invoked?.relative.split(path.sep)).toHaveLength(9);
      expect(invoked?.options).toMatchObject({
        denyMutations: { prefixes: [path.join(workspace, "mutation-admission-denied")] },
        mutationSymlinks: "reject",
        writeMode: "update",
      });
      row.options.verify(result);
      const fixtureRoot = path.join(workspace, invoked!.relative.split(path.sep)[0]);
      expect(fs.existsSync(fixtureRoot)).toBe(true);
      await row.options.after(result);
      expect(closed).toBe(true);
      expect(fs.existsSync(fixtureRoot)).toBe(false);
      row.options.before();
      expect(fs.readFileSync(path.join(workspace, invoked!.relative), "utf8")).toBe("original");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
