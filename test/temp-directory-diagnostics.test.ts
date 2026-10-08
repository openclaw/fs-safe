import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSecureTempRoot, withTempWorkspace, withTempWorkspaceSync } from "../src/temp.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("temp directory diagnostics", () => {
  for (const variant of ["async", "sync"] as const) {
    it(`${variant}: names the writable private root and a safe recovery`, async () => {
      const rootDir = await tempRoot("temp-diagnostic-");
      fs.chmodSync(rootDir, 0o1777);
      const callback = vi.fn();
      const run = () => variant === "async"
        ? withTempWorkspace({ rootDir, prefix: "proof-" }, callback)
        : withTempWorkspaceSync({ rootDir, prefix: "proof-" }, callback);
      await expect(Promise.resolve().then(run)).rejects.toMatchObject({
        code: "insecure-permissions",
        message: expect.stringContaining(rootDir),
      });
      await expect(Promise.resolve().then(run)).rejects.toThrow(/mode 1777.*sticky bit.*0700/);
      expect(callback).not.toHaveBeenCalled();
      expect(fs.statSync(rootDir).mode & 0o7777).toBe(0o1777);
    });

    it(`${variant}: names the non-sticky ancestor, not just the private root`, async () => {
      const ancestor = await tempRoot("temp-diagnostic-");
      const rootDir = path.join(ancestor, "private");
      fs.mkdirSync(rootDir, { mode: 0o700 });
      fs.chmodSync(ancestor, 0o777);
      const run = () => variant === "async"
        ? withTempWorkspace({ rootDir, prefix: "proof-" }, () => {})
        : withTempWorkspaceSync({ rootDir, prefix: "proof-" }, () => {});
      await expect(Promise.resolve().then(run)).rejects.toMatchObject({
        code: "insecure-permissions",
        message: expect.stringContaining(JSON.stringify(ancestor)),
      });
      await expect(Promise.resolve().then(run)).rejects.toThrow(/mode 0777.*sticky bit.*1777/);
      expect(fs.readdirSync(rootDir)).toEqual([]);
    });
  }

  it.each([0, 1001])("secure root diagnoses foreign ownership for uid %i", (uid) => {
    expect(() => resolveSecureTempRoot({
      fallbackPrefix: "diagnostic",
      tmpdir: () => "/tmp",
      getuid: () => uid,
      lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1002, mode: 0o40777 }),
    })).toThrow(new RegExp(`diagnostic-${uid}.*owner uid 1002.*expected uid ${uid}.*0700`));
  });

  it("secure root names a planted symlink and refuses to repair its target", async () => {
    const base = await tempRoot("temp-diagnostic-");
    const target = path.join(base, "target");
    fs.mkdirSync(target, { mode: 0o755 });
    const link = path.join(base, `planted-${process.getuid!()}`);
    fs.symlinkSync(target, link);
    expect(() => resolveSecureTempRoot({ fallbackPrefix: "planted", tmpdir: () => base }))
      .toThrow(new RegExp(`planted-${process.getuid!()}.*symbolic link.*real directory`));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });
});

describe.skipIf(process.platform === "win32")("root and non-root temp ownership matrix", () => {
  for (const uid of [0, 1001]) {
    for (const bigint of [false, true]) {
      it.each([
        { owner: uid, mode: 0o700, privateRoot: true },
        { owner: uid, mode: 0o755, privateRoot: true },
        { owner: 0, mode: 0o1777, privateRoot: false },
        { owner: uid, mode: 0o1777, privateRoot: true, code: "insecure-permissions" },
        { owner: 0, mode: 0o777, privateRoot: false, code: "insecure-permissions" },
        { owner: 1002, mode: 0o777, privateRoot: false, code: "not-owned" },
        { owner: 1002, mode: 0o1777, privateRoot: false, code: "not-owned" },
        { owner: 1002, mode: 0o700, privateRoot: true, code: "not-owned" },
        ...(uid === 0 ? [] : [{ owner: 0, mode: 0o700, privateRoot: true, code: "not-owned" }]),
      ])(`euid ${uid}, bigint ${bigint}: %j`, async ({ owner, mode, privateRoot, code }) => {
        const { assertTrustedTempWorkspaceDirectory } = await import("../src/temp-workspace-child-admission.js");
        const stat = bigint
          ? { uid: BigInt(owner), gid: 0n, mode: BigInt(mode) }
          : { uid: owner, gid: 0, mode };
        const dir = "/tmp/matrix-directory";
        const run = () => assertTrustedTempWorkspaceDirectory(stat, uid, privateRoot, dir);
        if (code) {
          expect(run).toThrow(expect.objectContaining({ code, message: expect.stringContaining(dir) }));
          if (code === "not-owned") {
            expect(run).toThrow(new RegExp(`owner uid ${owner}.*expected uid ${uid}`));
          } else {
            expect(run).toThrow(new RegExp(`mode ${mode.toString(8).padStart(4, "0")}.*sticky`));
          }
        } else {
          expect(run).not.toThrow();
        }
      });
    }
  }
});
