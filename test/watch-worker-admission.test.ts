import { expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { NodeWatchBackend } from "../src/watch-node.js";

// Controlled resource-exhaustion injection; never change the host's limits.
vi.mock("node:worker_threads", () => ({
  Worker: class {
    constructor() { throw Object.assign(new Error("worker descriptor budget"), { code: "EMFILE" }); }
  },
}));

it("retains watch provenance when worker acquisition itself exhausts resources", () => {
  let caught: unknown;
  try { new NodeWatchBackend(() => {}, () => {}, true, 2); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(FsSafeError);
  expect(caught).toMatchObject({
    code: "helper-failed", details: { operation: "watch", code: "EMFILE" },
    cause: { code: "EMFILE" },
  });
});
