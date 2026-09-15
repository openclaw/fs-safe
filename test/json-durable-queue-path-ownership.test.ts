import fsSync from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import {
  claimDurableQueueEntry,
  validateDurableQueueEntryPaths,
  type DurableQueueEntryPathsLike,
} from "../src/json-durable-queue-ownership.js";

const validPaths = {
  jsonPath: "queue/job.json",
  deliveredPath: "queue/job.delivered",
  processingPath: "queue/job.processing",
};

describe("durable queue owned path records", () => {
  it.each(["jsonPath", "deliveredPath", "processingPath"] as const)(
    "rejects a mutable Buffer %s before filesystem admission",
    async (field) => {
      const lstat = vi.spyOn(fsSync, "lstatSync");
      const paths = { ...validPaths, [field]: Buffer.from(validPaths[field]) };
      await expect(claimDurableQueueEntry(paths as unknown as DurableQueueEntryPathsLike))
        .rejects.toMatchObject({ code: "invalid-path" });
      expect(lstat).not.toHaveBeenCalled();
      lstat.mockRestore();
    },
  );

  it("captures every path getter once before validating their primitive types", () => {
    const reads = { jsonPath: 0, deliveredPath: 0, processingPath: 0 };
    const paths = Object.fromEntries(Object.keys(reads).map((field) => [field, undefined]));
    for (const field of Object.keys(reads) as Array<keyof typeof reads>) {
      Object.defineProperty(paths, field, {
        enumerable: true,
        get() {
          reads[field] += 1;
          return field === "jsonPath" ? new String(validPaths[field]) : validPaths[field];
        },
      });
    }
    expect(() => validateDurableQueueEntryPaths(paths as DurableQueueEntryPathsLike))
      .toThrow(FsSafeError);
    expect(reads).toEqual({ jsonPath: 1, deliveredPath: 1, processingPath: 1 });
  });

  it("stores primitive snapshots independently of later caller mutation", () => {
    const paths = { ...validPaths };
    const owned = validateDurableQueueEntryPaths(paths);
    paths.jsonPath = "queue/decoy.json";
    expect(owned).toEqual(validPaths);
    expect(Object.isFrozen(owned)).toBe(true);
  });

  it("does not extend WeakSet trust through a copied Proxy wrapper", async () => {
    const owned = validateDurableQueueEntryPaths(validPaths);
    const wrapped = new Proxy({ ...owned }, {
      get(target, property, receiver) {
        if (property === "processingPath") return Buffer.from(target.processingPath);
        return Reflect.get(target, property, receiver);
      },
    });
    const lstat = vi.spyOn(fsSync, "lstatSync");
    await expect(claimDurableQueueEntry(wrapped as unknown as DurableQueueEntryPathsLike))
      .rejects.toMatchObject({ code: "invalid-path" });
    expect(lstat).not.toHaveBeenCalled();
    lstat.mockRestore();
  });
});
