import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureFsSafeNative,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import * as writeAdmission from "../src/root-write-admission.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let bundledNative: NativeBinding | undefined;
if (process.platform === "win32") {
  try {
    bundledNative = __loadBundledNativeForTest();
  } catch {
    // The binding-specific case is skipped when the optional package is absent.
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function unrelatedPolicy(directory: string) {
  return { paths: [path.join(directory, "unrelated")] };
}

function atomicStages(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry.startsWith(".fs-safe-") && entry.endsWith(".tmp"));
}

describe.skipIf(process.platform !== "win32")(
  "Windows legacy overwrite mutation-policy boundaries",
  () => {
    it.each([
      { boundary: "stage", admission: 3 },
      { boundary: "publication", admission: 4 },
    ])("re-authorizes the original final-link target before $boundary", async ({ admission }) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-win-policy-admission-");
      const allowed = path.join(directory, "allowed");
      const denied = path.join(directory, "denied");
      const alias = path.join(directory, "alias");
      await fs.writeFile(allowed, "allowed");
      await fs.writeFile(denied, "denied");
      await fs.symlink(allowed, alias, "file");
      let checks = 0;
      __setFsSafeTestHooksForTest({
        async beforePinnedWriteParentAdmission() {
          if (++checks !== admission) return;
          await fs.unlink(alias);
          await fs.symlink(denied, alias, "file");
        },
      });
      const safe = await root(directory);

      await expect(safe.write("alias", Buffer.from("replacement"), {
        denyMutations: { paths: [denied] },
        durable: false,
      })).rejects.toMatchObject({ code: "denied-path" });

      expect(checks).toBe(admission);
      expect(await fs.readFile(allowed, "utf8")).toBe("allowed");
      expect(await fs.readFile(denied, "utf8")).toBe("denied");
      expect(atomicStages(await fs.readdir(directory))).toEqual([]);
    });

    it.each([
      { boundary: "stage", callback: 1 },
      { boundary: "publication", callback: 3 },
    ])("honors authority revocation before $boundary", async ({ callback }) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-win-policy-revocation-");
      const target = path.join(directory, "target");
      await fs.writeFile(target, "original");
      const revoked = new Error("revoked");
      let callbacks = 0;
      const safe = await root(directory);

      await expect(safe.write("target", Buffer.from("replacement"), {
        denyMutations: unrelatedPolicy(directory),
        durable: false,
        assertBeforeMutation() {
          if (++callbacks === callback) throw revoked;
        },
      })).rejects.toBe(revoked);

      expect(callbacks).toBe(callback);
      expect(await fs.readFile(target, "utf8")).toBe("original");
      expect(await fs.readdir(directory)).toEqual(["target"]);
    });

    it.each([
      { boundary: "stage", callback: 1 },
      { boundary: "publication", callback: 3 },
    ])("uses the retained exact parent fence after the $boundary callback", async ({
      boundary,
      callback,
    }) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-win-policy-parent-fence-");
      const parent = path.join(directory, "parent");
      const target = path.join(parent, "target");
      await fs.mkdir(parent);
      await fs.writeFile(target, "original");
      let callbacks = 0;
      const safe = await root(directory);
      const handles: FileHandle[] = [];
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        handles.push(handle);
        return handle;
      });
      let parentChanged = false;
      let parentInspectionsAfterCallback = 0;
      let changedIno: bigint | undefined;
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (parentChanged && name === parent && options?.bigint === true &&
          typeof stat.ino === "bigint") {
          parentInspectionsAfterCallback += 1;
          changedIno ??= stat.ino === 1n ? 2n : 1n;
          stat.ino = changedIno;
        }
        return stat;
      });
      const rename = vi.spyOn(fs, "rename");

      try {
        await expect(safe.write("parent/target", Buffer.from("replacement"), {
          denyMutations: unrelatedPolicy(directory),
          durable: false,
          assertBeforeMutation() {
            if (++callbacks === callback) parentChanged = true;
          },
        })).rejects.toMatchObject({ code: "path-mismatch" });

        expect(callbacks).toBe(callback);
        expect(parentChanged).toBe(true);
        expect(parentInspectionsAfterCallback).toBeGreaterThan(0);
        expect(rename).not.toHaveBeenCalled();
        expect(await fs.readFile(target, "utf8")).toBe("original");
        const stages = atomicStages(await fs.readdir(parent));
        // The real cleanup guard also rejects the persistent parent mismatch.
        expect(stages).toHaveLength(boundary === "publication" ? 1 : 0);
        expect(handles).toHaveLength(boundary === "publication" ? 2 : 1);
        expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it.each(["stage", "publication"] as const)("keeps a missing destination absent after %s revocation", async boundary => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-win-policy-owned-cleanup-");
      const target = path.join(directory, "target");
      const payload = Buffer.from("replacement");
      const revoked = new Error("revoked");
      let refused = false;
      let callbacksAfterRefusal = 0;
      let completeStageObserved = false;
      const safe = await root(directory);
      const rename = vi.spyOn(fs, "rename");

      await expect(safe.write("target", payload, {
        denyMutations: unrelatedPolicy(directory),
        durable: false,
        assertBeforeMutation() {
          if (refused) { callbacksAfterRefusal += 1; throw revoked; }
          expect(fsSync.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
          const stages = atomicStages(fsSync.readdirSync(directory));
          if (boundary === "stage") expect(stages).toEqual([]);
          else {
            expect(stages.length).toBeLessThanOrEqual(1);
            if (!stages.length) return;
            const stage = path.join(directory, stages[0]!);
            const stat = fsSync.lstatSync(stage);
            if (stat.size !== payload.length) return;
            expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true);
            expect(fsSync.readFileSync(stage)).toEqual(payload);
            completeStageObserved = true;
          }
          refused = true;
          throw revoked;
        },
      })).rejects.toBe(revoked);

      expect(refused).toBe(true);
      expect(callbacksAfterRefusal).toBe(0);
      expect(completeStageObserved).toBe(boundary === "publication");
      expect(rename.mock.calls.some(([, destination]) => destination === target)).toBe(false);
      expect(await fs.readdir(directory)).toEqual([]);
    });

    it("keeps the open-to-stage policy snapshot when the caller mutates its array", async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-win-policy-snapshot-");
      const target = path.join(directory, "target");
      await fs.writeFile(target, "original");
      const denied = [path.join(directory, "unrelated")];
      let admissions = 0;
      __setFsSafeTestHooksForTest({
        beforePinnedWriteParentAdmission() {
          if (++admissions === 3) denied.splice(0, denied.length, target);
        },
      });
      const safe = await root(directory);

      await expect(safe.write("target", Buffer.from("replacement"), {
        denyMutations: { paths: denied },
        durable: false,
      })).resolves.toBeUndefined();

      expect(admissions).toBe(4);
      expect(await fs.readFile(target, "utf8")).toBe("replacement");
    });

    it("preserves an unchanged final symlink through legacy publication", async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-win-policy-final-link-");
      const target = path.join(directory, "target");
      const alias = path.join(directory, "alias");
      await fs.writeFile(target, "original");
      await fs.symlink(target, alias, "file");
      const safe = await root(directory);

      await expect(safe.write("alias", Buffer.from("replacement"), {
        denyMutations: unrelatedPolicy(directory),
        durable: false,
      })).resolves.toBeUndefined();

      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe("replacement");
      expect(atomicStages(await fs.readdir(directory))).toEqual([]);
    });

    it.for(["authorization", "binding"] as const)(
      "keeps a case-distinct selected destination under exact %s checks",
      { timeout: 20_000 },
      async (boundary, context) => {
        configureFsSafeNative({ mode: "off" });
        const directory = await tempRoot("fs-safe-win-policy-case-sensitive-");
        const enabled = spawnSync(
          resolveWindowsSystemCommand("fsutil.exe"),
          ["file", "setCaseSensitiveInfo", directory, "enable"],
          { stdio: "ignore", timeout: 10_000, windowsHide: true },
        );
        if (enabled.error || enabled.status !== 0) {
          context.skip();
          return;
        }
        const selected = path.join(directory, "value");
        const alias = path.join(directory, "VALUE");
        const retarget = path.join(directory, "other");
        const initiallyAllowed = path.join(directory, "initially-allowed");
        const deniedAlias = path.join(directory, "denied-alias");
        await fs.writeFile(selected, "selected");
        await fs.writeFile(retarget, "other");
        await fs.writeFile(initiallyAllowed, "allowed");
        try {
          await fs.symlink(selected, alias, "file");
        } catch (error) {
          if (error && typeof error === "object" && "code" in error &&
            (error.code === "EEXIST" || error.code === "EPERM")) {
            context.skip();
            return;
          }
          throw error;
        }
        const entries = await fs.readdir(directory);
        expect(entries).toContain("value");
        expect(entries).toContain("VALUE");
        const selectedEntry = await fs.lstat(selected, { bigint: true });
        const aliasEntry = await fs.lstat(alias, { bigint: true });
        expect(selectedEntry.isFile()).toBe(true);
        expect(selectedEntry.isSymbolicLink()).toBe(false);
        expect(aliasEntry.isSymbolicLink()).toBe(true);
        expect(selectedEntry.dev === aliasEntry.dev && selectedEntry.ino === aliasEntry.ino)
          .toBe(false);
        if (boundary === "authorization") {
          await fs.symlink(initiallyAllowed, deniedAlias, "file");
        }
        // Do not let setup that outlived its test install process-global
        // instrumentation after Vitest has started teardown.
        context.signal.throwIfAborted();
        const handles: FileHandle[] = [];
        const realOpen = fs.open.bind(fs);
        const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const handle = await realOpen(...args);
          handles.push(handle);
          return handle;
        });
        let admissions = 0;
        let policyRetargeted = false;
        let selectedAdmissionChecks = 0;
        if (boundary === "authorization") {
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
              await fs.unlink(alias);
              await fs.symlink(retarget, alias, "file");
            },
          });
        }
        const callback = vi.fn();
        const safe = await root(directory);
        const opening = safe.openWritable("VALUE", {
          writeMode: "update",
          assertBeforeMutation: callback,
          denyMutations: boundary === "authorization"
            ? { paths: [deniedAlias] }
            : unrelatedPolicy(directory),
        }).then(async opened => await opened.handle.close());

        await expect(opening).rejects.toMatchObject({
          code: boundary === "authorization" ? "denied-path" : "path-mismatch",
        });

        expect(admissions).toBe(boundary === "authorization" ? 1 : 2);
        expect(policyRetargeted).toBe(boundary === "authorization");
        expect(selectedAdmissionChecks).toBe(boundary === "authorization" ? 1 : 0);
        expect(callback).not.toHaveBeenCalled();
        if (boundary === "authorization") expect(open).not.toHaveBeenCalled();
        expect(await fs.readFile(selected, "utf8")).toBe("selected");
        expect(await fs.readFile(retarget, "utf8")).toBe("other");
        expect(handles.every((handle) => handle.fd === -1)).toBe(true);
        expect(handles).toHaveLength(boundary === "authorization" ? 0 : 1);
      },
    );

    it.skipIf(!bundledNative)(
      "uses the policy-fenced verify-content-with-lock route with a binding available",
      async () => {
        __setNativeLoaderForTest(() => bundledNative!);
        configureFsSafeNative({ mode: "auto" });
        const directory = await tempRoot("fs-safe-win-policy-binding-route-");
        const target = path.join(directory, "target");
        await fs.writeFile(target, "original");
        let admissions = 0;
        __setFsSafeTestHooksForTest({
          beforePinnedWriteParentAdmission() {
            admissions += 1;
          },
        });
        const safe = await root(directory, { renameIdentity: "verify-content-with-lock" });

        await expect(safe.write("target", Buffer.from("replacement"), {
          denyMutations: unrelatedPolicy(directory),
          durable: false,
        })).resolves.toBeUndefined();

        expect(admissions).toBe(4);
        expect(await fs.readFile(target, "utf8")).toBe("replacement");
        expect(await fs.readdir(directory)).toEqual(["target"]);
      },
    );
  },
);
