import { describe, expect, it } from "vitest";
import {
  ATOMIC_SETTLEMENT_NAMES,
  registerAtomicSettlement,
} from "../benchmarks/atomic-settlement.mjs";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

describe("atomic settlement benchmark coverage", () => {
  it("registers exact successful async, sync, and store workloads", async () => {
    const workspace = await tempRoot("fs-safe-benchmark-atomic-settlement-");
    const rows: Array<{
      name: string;
      options: {
        before?: () => unknown;
        divisor?: number;
        sync?: boolean;
        verify?: (result: unknown) => void;
        workloadDetails?: Record<string, unknown>;
        workloadSemantics?: string;
      };
    }> = [];
    registerAtomicSettlement({
      api: {
        fileStoreSync: () => ({ write: () => undefined }),
        replaceFileAtomic: async () => undefined,
        replaceFileAtomicSync: () => undefined,
      },
      workspace,
      register: (name: string, _run: () => unknown, options: (typeof rows)[number]["options"]) => {
        rows.push({ name, options });
      },
    });

    expect(rows.map(row => row.name)).toEqual(ATOMIC_SETTLEMENT_NAMES);
    expect(rows.map(row => row.options.sync)).toEqual([undefined, true, true]);
    for (const row of rows) {
      expect(row.options.before).toBeTypeOf("function");
      expect(row.options.verify).toBeTypeOf("function");
      expect(row.options.divisor).toBe(20);
      expect(row.options.workloadSemantics).toContain("fixture setup and verification are untimed");
      expect(row.options.workloadDetails).toEqual({
        bytes: 28,
        destination: "existing",
        durable: false,
        settlement: "publication-then-retained-handle-close",
      });
    }
  });
});
