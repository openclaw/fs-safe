import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findExistingAncestor } from "../src/absolute-path.js";
import { inspectPathPermissions } from "../src/permissions.js";
import { assertNoSymlinkParents, assertNoSymlinkParentsSync } from "../src/symlink-parents.js";
import { isNonRegularWriteOpenError, isNonRegularWriteOpenErrorSync } from "../src/write-open-flags.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function captureThrown(run: () => unknown): { threw: boolean; error?: unknown } {
  try {
    run();
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
}

describe("shared filesystem wrapper contracts", () => {
  it.each([null, undefined, Object.assign(new Error("inspection denied"), { code: "EACCES" })])(
    "preserves symlink-parent failure %s and each API's error surface",
    async failure => {
      const root = await tempRoot("fs-safe-parent-wrapper-");
      const target = path.join(root, "leaf");
      const events: string[] = [];
      const lstat = fsSync.lstatSync;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
        if (String(candidate) === target) {
          events.push("lstat");
          throw failure;
        }
        return lstat(candidate, options as never);
      });
      const options = {
        get rootDir() { events.push("root"); expect(this).toBe(options); return root; },
        get targetPath() { events.push("target"); expect(this).toBe(options); return target; },
      };
      let pending!: Promise<void>;
      expect(() => { pending = assertNoSymlinkParents(options); }).not.toThrow();
      expect(pending).toBeInstanceOf(Promise);
      expect(events).toEqual(["root", "target", "lstat"]);
      await expect(pending).rejects.toBe(failure);

      events.length = 0;
      const thrown = captureThrown(() => assertNoSymlinkParentsSync(options));
      expect(thrown.threw).toBe(true);
      expect(thrown.error).toBe(failure);
      expect(events).toEqual(["root", "target", "lstat"]);
    },
  );

  it("keeps classifier getter failures as rejections or synchronous throws", async () => {
    const failure = new Error("error code unavailable");
    let reads = 0;
    const error = { get code() { reads++; throw failure; } };
    let pending!: Promise<boolean>;
    expect(() => { pending = isNonRegularWriteOpenError(error, "unused", 0); }).not.toThrow();
    expect(reads).toBe(1);
    await expect(pending).rejects.toBe(failure);
    const thrown = captureThrown(() => isNonRegularWriteOpenErrorSync(error, "unused", 0));
    expect(thrown.threw).toBe(true);
    expect(thrown.error).toBe(failure);
    expect(reads).toBe(2);
  });

  it("walks only missing ancestor components and preserves observation errors", async () => {
    const root = await tempRoot("fs-safe-ancestor-wrapper-");
    const missing = path.join(root, "missing"), target = path.join(missing, "leaf");
    const observed: string[] = [];
    const lstat = fsSync.lstatSync;
    let denied = false;
    const failure = Object.assign(new Error("ancestor denied"), { code: "EACCES" });
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      observed.push(String(candidate));
      if (denied && String(candidate) === target) throw failure;
      return lstat(candidate, options as never);
    });
    const pending = findExistingAncestor(target);
    expect(observed).toEqual([target, missing, root]);
    await expect(pending).resolves.toBe(root);
    observed.length = 0;
    denied = true;
    let rejected!: Promise<string | null>;
    expect(() => { rejected = findExistingAncestor(target); }).not.toThrow();
    await expect(rejected).rejects.toBe(failure);
    expect(observed).toEqual([target]);
  });

  it.each(["alias", "stat failure"])("does no ACL work after %s admission", async route => {
    const root = await tempRoot("fs-safe-permission-wrapper-");
    const target = route === "alias" ? "C:\\fixture\\secret:stream" : path.join(root, "secret");
    const failure = Object.assign(new Error("stat denied"), { code: "EACCES" });
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(() => { throw failure; });
    let platformReads = 0, execReads = 0;
    const result = await inspectPathPermissions(target, {
      get platform() { platformReads++; return "win32"; },
      get exec(): never { execReads++; throw new Error("unexpected ACL work"); },
    });
    expect(result).toEqual({
      ok: false, isSymlink: false, isDir: false, mode: null, bits: null,
      source: "unknown", worldWritable: false, groupWritable: false,
      worldReadable: false, groupReadable: false,
      error: route === "alias" ? "Path uses a Windows filesystem namespace alias" : String(failure),
    });
    expect(lstat).toHaveBeenCalledTimes(route === "alias" ? 0 : 1);
    expect(platformReads).toBe(process.platform === "win32" ? 0 : 1);
    expect(execReads).toBe(0);
  });
});
