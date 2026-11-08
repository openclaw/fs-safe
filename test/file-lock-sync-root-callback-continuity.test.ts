import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("synchronous Root callback admission", () => {
  it.each(["serialization", "mutation", "exclusive-open", "publication"] as const)(
    "rejects same-target callback reentry during %s without publishing a second owner",
    async stage => {
      const directory = await tempRoot("fs-safe-root-callback-admission-");
      const target = path.join(directory, "target");
      const lockPath = path.join(directory, "outer.lock");
      const nestedPath = path.join(directory, "nested.lock");
      let active = false;
      let nestedPayloadCalls = 0;
      let reentries = 0;
      const lockRoot = await root(directory, { assertBeforeMutation() {
        if (stage === "mutation" && active) attemptNested();
      } });
      const attemptNested = () => {
        if (!active) return;
        active = false;
        reentries++;
        expect(() => acquireFileLockSync(target, {
          lockRoot, lockPath: nestedPath, reentrantOwner: "owner",
          payload() { nestedPayloadCalls++; return { owner: "nested" }; },
        })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
      };
      if (stage === "exclusive-open") {
        const open = fs.openSync.bind(fs);
        vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
          if (String(args[0]) === lockPath && typeof args[1] === "number" &&
            (args[1] & fs.constants.O_CREAT)) attemptNested();
          return open(...args);
        }) as typeof fs.openSync);
      }
      if (stage === "publication") {
        const sync = fs.fsyncSync.bind(fs);
        vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { attemptNested(); sync(fd); });
      }
      active = true;
      const held = acquireFileLockSync(target, {
        lockRoot, lockPath, reentrantOwner: "owner", payload() {
          return { owner: "outer", toJSON() {
            if (stage === "serialization") attemptNested();
            return { owner: "outer" };
          } };
        },
      });
      try {
        expect(reentries).toBe(1);
        expect(nestedPayloadCalls).toBe(0);
        expect(fs.existsSync(nestedPath)).toBe(false);
        expect(held.verifyStillHeld()).toBe(true);
      } finally { held.release(); }
      expect(fs.existsSync(lockPath)).toBe(false);
      const next = acquireFileLockSync(target, {
        lockRoot, lockPath: nestedPath, payload: () => ({ owner: "next" }),
      });
      expect(next.verifyStillHeld()).toBe(true);
      next.release();
    },
  );
});
