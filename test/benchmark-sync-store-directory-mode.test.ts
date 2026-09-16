import { describe, expect, it } from "vitest";
import {
  registerSyncStoreDirectoryModes,
  SYNC_STORE_DIRECTORY_MODE_NAMES,
} from "../benchmarks/sync-store-directory-mode.mjs";

describe("synchronous store directory-mode benchmark coverage", () => {
  it("crosses layouts, depths, durability and private mode exactly once", () => {
    expect(SYNC_STORE_DIRECTORY_MODE_NAMES).toHaveLength(36);
    expect(new Set(SYNC_STORE_DIRECTORY_MODE_NAMES).size).toBe(36);
    for (const privateMode of [false, true]) {
      for (const durable of [false, true]) {
        for (const depth of [0, 4, 16]) {
          for (const layout of ["same-mode", "different-mode", "new-directories"]) {
            expect(SYNC_STORE_DIRECTORY_MODE_NAMES).toContain(
              `FileStoreSync.write/directory-mode/${layout}/depth=${depth}` +
              `/private=${privateMode}/durable=${durable}`,
            );
          }
        }
      }
    }
  });

  it("registers every write as synchronous work", () => {
    const options: Array<{ sync?: boolean }> = [];
    registerSyncStoreDirectoryModes({
      api: { fileStoreSync: () => ({ write: () => undefined }) },
      workspace: "benchmark-workspace",
      register: (_name: string, _run: () => unknown, row: { sync?: boolean }) => {
        options.push(row);
      },
    });
    expect(options).toHaveLength(36);
    expect(options.every((row) => row.sync === true)).toBe(true);
  });
});
