import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ASYNC_ATOMIC_HANDLE_OWNERSHIP_BENCHMARK_NAME,
  ASYNC_ATOMIC_HANDLE_OWNERSHIP_FIXTURE,
  ASYNC_ATOMIC_HANDLE_OWNERSHIP_WORKLOAD,
  registerAsyncAtomicHandleOwnership,
} from "../benchmarks/atomic-handle-ownership.mjs";

type RowOptions = {
  divisor: number;
  workloadSemantics: string;
  workloadDetails: Record<string, unknown>;
  fixturePlacement: Record<string, unknown>;
  before: () => void;
  after: (result: unknown) => void;
};

describe("async atomic handle-ownership benchmark", () => {
  it("binds the real public call and verifies every invocation outside timing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-atomic-handle-bench-"));
    let observed: Record<string, unknown> | undefined;
    const replaceFileAtomic = vi.fn(async (options: Record<string, unknown>) => {
      observed = options;
      fs.writeFileSync(options.filePath as string, options.content as Uint8Array);
      return { method: "rename" };
    });
    const rows: Array<{
      name: string;
      run: () => Promise<unknown>;
      options: RowOptions;
    }> = [];
    try {
      registerAsyncAtomicHandleOwnership({
        api: { replaceFileAtomic },
        workspace,
        register: (name: string, run: () => Promise<unknown>, options: RowOptions) => {
          rows.push({ name, run, options });
        },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.name).toBe(ASYNC_ATOMIC_HANDLE_OWNERSHIP_BENCHMARK_NAME);
      expect(row.options.divisor).toBe(20);
      expect(row.options.workloadSemantics).toBe("equivalent-output");
      expect(row.options.workloadDetails).toEqual(ASYNC_ATOMIC_HANDLE_OWNERSHIP_WORKLOAD);
      expect(row.options.fixturePlacement).toEqual(ASYNC_ATOMIC_HANDLE_OWNERSHIP_FIXTURE);
      expect(Object.isFrozen(row.options.workloadDetails)).toBe(true);
      expect(Object.isFrozen(row.options.fixturePlacement)).toBe(true);

      row.options.before();
      expect(fs.readFileSync(path.join(workspace, "atomic-handle-ownership", "target"), "utf8"))
        .toBe("previous");
      const result = await row.run();
      expect(observed).toMatchObject({
        tempPrefix: ".fs-safe-bench-atomic-finish",
        syncTempFile: false,
        syncParentDir: false,
      });
      expect(Buffer.from(observed!.content as Uint8Array)).toHaveLength(32);
      expect(() => row.options.after(result)).not.toThrow();
      expect(fs.existsSync(path.join(workspace, "atomic-handle-ownership"))).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an owned sibling temp receipt and still removes the fixture", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-atomic-handle-bench-"));
    const rows: Array<{ options: RowOptions }> = [];
    try {
      registerAsyncAtomicHandleOwnership({
        api: { replaceFileAtomic: vi.fn() },
        workspace,
        register: (_name: string, _run: () => Promise<unknown>, options: RowOptions) => {
          rows.push({ options });
        },
      });
      const row = rows[0]!;
      row.options.before();
      const fixture = path.join(workspace, "atomic-handle-ownership");
      fs.writeFileSync(path.join(fixture, "target"),
        Buffer.from("0123456789abcdef0123456789abcdef"));
      fs.writeFileSync(path.join(fixture, ".fs-safe-bench-atomic-finish.leaked.tmp"), "leak");

      expect(() => row.options.after({ method: "rename" })).toThrow();
      expect(fs.existsSync(fixture)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
