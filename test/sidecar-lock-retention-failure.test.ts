import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { allowWindowsFilesystemStalls, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
allowWindowsFilesystemStalls();
let native;
try { native = __loadBundledNativeForTest(); } catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
beforeEach(() => configureFsSafeNative({ mode: "require" }));
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); __resetNativeLoaderForTest(); });

describe.skipIf(!native)("failed retained-sidecar admission", () => {
  const kinds = ["unchanged", "removed-name", "same-byte-replacement", "changed-owner",
    ...(process.platform === "win32" ? [] : ["moved-root"])];
  const points = process.platform === "win32" ? ["binding-throw", "failed-admission"] : ["parent-open", "file-open"];
  it.each(points.flatMap(point => kinds.map(kind => ({ point, kind }))))(
    "settles the creator safely after $point fails over $kind", async ({ point, kind }) => {
      const base = await tempRoot("sidecar-retention-failure-");
      const directory = path.join(base, "data"), moved = path.join(base, "moved");
      fs.mkdirSync(directory);
      const target = path.join(directory, "state"), lockPath = `${target}.lock`;
      const capability = await root(directory, { durable: false });
      const manager = createFileLockManager(directory);
      const failure = Object.assign(new Error("retention admission failed"), { code: "EMFILE" });
      let expected = "";
      let failed = false;
      const mutate = () => {
        failed = true;
        const raw = fs.readFileSync(lockPath, "utf8");
        if (kind === "same-byte-replacement") {
          fs.renameSync(lockPath, `${lockPath}.old`);
          fs.writeFileSync(lockPath, raw);
          expected = raw;
        } else if (kind === "changed-owner") {
          fs.writeFileSync(lockPath, "foreign owner");
          expected = "foreign owner";
        } else if (kind === "moved-root") fs.renameSync(directory, moved);
        else if (kind === "removed-name") fs.unlinkSync(lockPath);
      };
      if (process.platform === "win32") {
        __setNativeLoaderForTest(() => ({ ...native!, retainWindowsSidecar() {
          mutate();
          if (point === "binding-throw") throw failure;
          return {
            admission: { status: "failed", phase: "admission", disposition: "not-attempted",
              namespace: "not-observed", resources: "closed", persistence: "not-proven",
              errors: [{ phase: "admission", code: "EMFILE", message: failure.message }] } as const,
            settle() { throw new Error("failed admission already closed its handles"); },
          };
        } }));
      } else {
        let created = false;
        __setNativeLoaderForTest(() => ({ ...native!,
          createStagedFile(parent, name) {
            const fd = native!.createStagedFile!(parent, name);
            created = true;
            return fd;
          },
          openBeneath(parent, name, flags) {
          const retentionOpen = point === "parent-open" ? created && name === ""
            : name === "state.lock" && (flags & fs.constants.O_NONBLOCK) !== 0;
          if (!failed && retentionOpen) {
            mutate(); throw failure;
          }
          return native!.openBeneath(parent, name, flags);
        } }));
      }
      const result = await manager.acquire(target, { lockRoot: capability, payload: () => ({ owner: "ours" }) })
        .catch(error => error);
      expect(failed).toBe(true);
      expect(manager.heldEntries()).toEqual([]);
      if (kind === "unchanged" || kind === "moved-root" || kind === "removed-name") {
        expect(result).toBeInstanceOf(Error);
        expect(fs.existsSync(path.join(kind === "moved-root" ? moved : directory, "state.lock"))).toBe(false);
        if (kind === "moved-root") fs.renameSync(moved, directory);
        vi.restoreAllMocks();
        __resetNativeLoaderForTest();
        const next = await manager.acquire(target, {
          lockRoot: capability, timeoutMs: 1000, payload: () => ({ owner: "next" }),
        });
        await next.release();
        expect(fs.readdirSync(directory)).toEqual([]);
      } else {
        expect(result).toMatchObject({ name: "SuppressedError", error: { code: "path-mismatch" } });
        expect(fs.readFileSync(lockPath, "utf8")).toBe(expected);
      }
    },
  );
});
