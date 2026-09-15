import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import { tempWorkspace, tempWorkspaceSync, type TempWorkspaceOptions } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
type SafeIdentity = Readonly<{ dev: number; ino: number }>;

function projectSafeIdentity(
  stat: { dev: number | bigint; ino: number | bigint },
  identity: SafeIdentity,
): void {
  stat.dev = typeof stat.dev === "bigint" ? BigInt(identity.dev) : identity.dev;
  stat.ino = typeof stat.ino === "bigint" ? BigInt(identity.ino) : identity.ino;
}

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const variant of ["async", "sync"] as const) {
  describe(`${variant} temp workspace admission observations`, () => {
    async function create(rootDir: string, options: Partial<TempWorkspaceOptions> = {}) {
      const params = { rootDir, prefix: "workspace-", ...options };
      return variant === "async" ? await tempWorkspace(params) : tempWorkspaceSync(params);
    }

    it("canonicalizes only the complete root during each admission pass", async () => {
      const base = await tempRoot("fs-safe-workspace-canonical-passes-");
      const rootDir = path.join(base, "one", "two", "three");
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
      const canonicalize = vi.spyOn(realpathSync, "native");
      const workspace = await create(rootDir);
      try {
        // Discovery, the coalesced pre-mutation ancestry/parent association,
        // post-mutation parent association, and final ancestry validation.
        expect(canonicalize).toHaveBeenCalledTimes(4);
      } finally {
        canonicalize.mockRestore();
        await workspace.cleanup();
      }
    });

    it("retains one exact ancestor receipt and replays it numerically", async () => {
      for (const missing of [0, 1, 3, 6]) {
        const base = await tempRoot("fs-safe-workspace-observations-");
        const admittedBase = realpathSync.native(base);
        const existing = path.join(base, "existing");
        await fs.mkdir(existing, { mode: 0o700 });
        const rootDir = path.join(existing, ...Array.from({ length: missing }, (_, index) => `part-${index}`));
        let exactAncestorObservations = 0;
        let numericAncestorObservations = 0;
        const identity = { dev: 101, ino: 201 + missing };
        const lstat = fsSync.lstatSync.bind(fsSync);
        const observation = vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (name === admittedBase) {
            projectSafeIdentity(stat, identity);
            if (options?.bigint === true) exactAncestorObservations += 1;
            else numericAncestorObservations += 1;
          }
          return stat;
        });
        const workspace = await create(rootDir);
        observation.mockRestore();
        try {
          expect(exactAncestorObservations).toBe(1);
          // Existing canonical roots capture their exact receipt at the
          // pre-mkdtemp boundary, then replay it only for final adoption.
          // Missing creation retains its guarded three numeric replays.
          expect(numericAncestorObservations).toBe(missing === 0 ? 1 : 3);
        } finally {
          await workspace.cleanup();
        }
      }
    });

    it.runIf(process.platform !== "win32")(
      "rejects a final-adoption numeric mismatch without exact retry or registration", async () => {
        const base = await tempRoot("fs-safe-workspace-numeric-mismatch-");
        const rootDir = path.join(base, "root");
        await fs.mkdir(rootDir, { mode: 0o700 });
        const admittedRoot = realpathSync.native(rootDir);
        const identity = { dev: 301, ino: 401 };
        let exact = 0;
        let numeric = 0;
        let parentFd: number | undefined;
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (args[0] === admittedRoot) parentFd = fd;
          return fd;
        });
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (name === admittedRoot) {
            projectSafeIdentity(stat, identity);
            if (options?.bigint === true) exact += 1;
            else if (exact > 0) {
              numeric += 1;
              // Linux reuses the discovery receipt once at precreation. Other
              // POSIX platforms retain the prior exact precreation replay.
              const finalReplay = process.platform === "linux" ? 3 : 2;
              if (numeric === finalReplay && typeof stat.ino === "number") stat.ino += 1;
            }
          }
          return stat;
        });
        const fstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
          const stat = fstat(fd, options);
          if (fd === parentFd) {
            projectSafeIdentity(stat, identity);
          }
          return stat;
        });
        const canonicalize = vi.spyOn(realpathSync, "native");
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
        expect(exact).toBe(process.platform === "linux" ? 1 : 2);
        expect(numeric).toBe(process.platform === "linux" ? 3 : 2);
        expect(canonicalize.mock.calls.filter(([name]) =>
          name === rootDir || name === admittedRoot)).toHaveLength(3);
        expect(register).not.toHaveBeenCalled();
        const children = await fs.readdir(rootDir);
        expect(children).toHaveLength(1);
        expect(children[0]).toMatch(/^workspace-/);
        expect(fsSync.lstatSync(path.join(rootDir, children[0]!)).isDirectory()).toBe(true);
      },
    );

    it("keeps unsafe initial ancestor identities on exact replay", async () => {
      const base = await tempRoot("fs-safe-workspace-exact-replay-");
      const ancestor = path.join(base, "ancestor");
      const rootDir = path.join(ancestor, "root");
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
      const admittedAncestor = realpathSync.native(ancestor);
      const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
      let exact = 0;
      let numeric = 0;
      const lstat = fsSync.lstatSync.bind(fsSync);
      const observation = vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (name === admittedAncestor && options?.bigint === true && typeof stat.dev === "bigint") {
          exact += 1;
          stat.dev = unsafe;
          stat.ino = unsafe + 1n;
        } else if (name === admittedAncestor) {
          numeric += 1;
        }
        return stat;
      });
      const workspace = await create(rootDir);
      expect(exact).toBe(2);
      expect(numeric).toBe(0);
      observation.mockRestore();
      await workspace.cleanup();
    });

    it.runIf(process.platform === "win32").each(["zero", "unsafe", "mismatch"] as const)(
      "handles a %s Windows numeric identity without an unbounded retry", async (kind) => {
        const base = await tempRoot("fs-safe-workspace-windows-replay-");
        const rootDir = path.join(base, "root");
        await fs.mkdir(rootDir, { mode: 0o700 });
        const admittedRoot = realpathSync.native(rootDir);
        const fake = { dev: 101, ino: 202 };
        let exact = 0;
        let numeric = 0;
        let parentFd: number | undefined;
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (args[0] === admittedRoot) parentFd = fd;
          return fd;
        });
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (name !== admittedRoot) return stat;
          if (options?.bigint === true && typeof stat.dev === "bigint") {
            exact += 1;
            stat.dev = BigInt(fake.dev);
            stat.ino = BigInt(fake.ino);
          } else if (exact > 0 && typeof stat.dev === "number") {
            numeric += 1;
            stat.dev = fake.dev;
            stat.ino = fake.ino;
            if (numeric === 2) {
              // This is final adoption, so rejection must preserve the
              // unregistered child for caller-directed recovery.
              stat.ino = kind === "zero" ? 0 :
                kind === "unsafe" ? Number.MAX_SAFE_INTEGER + 1 : fake.ino + 1;
            }
          }
          return stat;
        });
        const fstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
          const stat = fstat(fd, options);
          if (fd === parentFd && options?.bigint === true && typeof stat.dev === "bigint") {
            stat.dev = BigInt(fake.dev);
            stat.ino = BigInt(fake.ino);
          }
          return stat;
        });
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        const operation = create(rootDir);
        if (kind === "mismatch") {
          await expect(operation).rejects.toMatchObject({ code: "path-mismatch" });
          expect(exact).toBe(2);
          expect(numeric).toBe(2);
          const children = await fs.readdir(rootDir);
          expect(children).toHaveLength(1);
          expect(children[0]).toMatch(/^workspace-/);
          expect(fsSync.lstatSync(path.join(rootDir, children[0]!)).isDirectory()).toBe(true);
          expect(register).not.toHaveBeenCalled();
        } else {
          const workspace = await operation;
          expect(exact).toBe(3);
          expect(numeric).toBe(2);
          await workspace.cleanup();
        }
      },
    );

    it.runIf(process.platform !== "win32")(
      "orders final ancestry, cleanup authority, child security, and registration", async () => {
        const base = await tempRoot("fs-safe-workspace-final-order-");
        const grandparent = path.join(base, "grandparent");
        const rootDir = path.join(grandparent, "parent", "root");
        await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
        const events: string[] = [];
        let modeChangeSettled = false;
        let rootObservationsAfterMode = 0;
        let cleanupParentFd: number | undefined;
        let cleanupParentObserved = false;
        let childFd: number | undefined;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        const openSync = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = openSync(...args);
          if (args[0] === rootDir) cleanupParentFd = fd;
          if (isChild(args[0])) childFd = fd;
          return fd;
        });
        if (variant === "async") {
          const fchmod = fsSync.fchmod.bind(fsSync);
          vi.spyOn(fsSync, "fchmod").mockImplementation((fd, mode, callback) => {
            return fchmod(fd, mode, (error) => {
              if (fd === childFd && !error) {
                modeChangeSettled = true;
                events.push("mode-settled");
              }
              callback(error);
            });
          });
        } else {
          const fchmod = fsSync.fchmodSync.bind(fsSync);
          vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
            fchmod(fd, mode);
            if (fd === childFd) {
              modeChangeSettled = true;
              events.push("mode-settled");
            }
          });
        }
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (modeChangeSettled && name === rootDir) {
            rootObservationsAfterMode += 1;
            if (rootObservationsAfterMode === 1) events.push("ancestry");
          }
          if (modeChangeSettled && isChild(name)) {
            events.push("child-security");
          }
          return stat;
        });
        const fstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
          const stat = fstat(fd, options);
          if (
            modeChangeSettled && rootObservationsAfterMode > 0 &&
            fd === cleanupParentFd && !cleanupParentObserved
          ) {
            cleanupParentObserved = true;
            events.push("cleanup-parent");
          }
          return stat;
        });
        const register = cleanup.registerTempPathForExit.bind(cleanup);
        vi.spyOn(cleanup, "registerTempPathForExit").mockImplementation((...args) => {
          events.push("register");
          return register(...args);
        });
        const workspace = await create(rootDir, { dirMode: 0o750 });
        try {
          expect(events).toEqual([
            "mode-settled", "ancestry", "cleanup-parent", "child-security", "register",
          ]);
        } finally {
          await workspace.cleanup();
        }
      },
    );

    it.runIf(process.platform !== "win32").each([
      "grandparent-mode", "child-replacement", "child-mode", "child-owner",
    ] as const)(
      "rejects %s after mode correction and before cleanup adoption", async (change) => {
        const base = await tempRoot("fs-safe-workspace-final-ancestry-");
        const grandparent = path.join(base, "grandparent");
        const rootDir = path.join(grandparent, "parent", "root");
        await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
        let child = "";
        let modeChangeSettled = false;
        let finalAncestryObserved = false;
        let childObservationsAfterMode = 0;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        const afterModeChange = () => {
          modeChangeSettled = true;
          if (change === "grandparent-mode") fsSync.chmodSync(grandparent, 0o770);
        };
        let childFd: number | undefined;
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (isChild(args[0])) {
            child = args[0];
            childFd = fd;
          }
          return fd;
        });
        if (variant === "async") {
          const fchmod = fsSync.fchmod.bind(fsSync);
          vi.spyOn(fsSync, "fchmod").mockImplementation((fd, mode, callback) => {
            return fchmod(fd, mode, (error) => {
              if (fd === childFd && !error) afterModeChange();
              callback(error);
            });
          });
        } else {
          const fchmod = fsSync.fchmodSync.bind(fsSync);
          vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
            fchmod(fd, mode);
            if (fd === childFd) afterModeChange();
          });
        }
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (modeChangeSettled && name === grandparent && !finalAncestryObserved) {
            finalAncestryObserved = true;
            if (change === "child-replacement") {
              // Keep the ancestry unchanged while substituting the child
              // during its final pass. The subsequent child check must reject.
              fsSync.renameSync(child, `${child}.original`);
              fsSync.mkdirSync(child, { mode: 0o700 });
              fsSync.writeFileSync(path.join(child, "keep"), "replacement");
            }
          }
          if (modeChangeSettled && name === child) {
            childObservationsAfterMode += 1;
            if (finalAncestryObserved) {
              if (change === "child-mode") {
                (stat as { mode: number | bigint }).mode = typeof stat.mode === "bigint"
                  ? (stat.mode & ~0o7777n) | 0o700n
                  : (stat.mode & ~0o7777) | 0o700;
              }
              if (change === "child-owner") {
                (stat as { uid: number | bigint }).uid = typeof stat.uid === "bigint"
                  ? BigInt(process.geteuid!()) + 1n
                  : process.geteuid!() + 1;
              }
            }
          }
          return stat;
        });
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        await expect(create(rootDir, { dirMode: 0o750 })).rejects.toMatchObject({
          code: change === "grandparent-mode" ? "insecure-permissions" :
            change === "child-owner" ? "not-owned" : "path-mismatch",
        });
        expect(modeChangeSettled).toBe(true);
        expect(finalAncestryObserved).toBe(true);
        expect(childObservationsAfterMode).toBe(change === "grandparent-mode" ? 0 : 1);
        expect(register).not.toHaveBeenCalled();
        cleanup.__cleanupRegisteredTempPathsForTest();
        expect(fsSync.statSync(child).isDirectory()).toBe(true);
        if (change === "grandparent-mode") {
          expect(fsSync.statSync(grandparent).mode & 0o777).toBe(0o770);
        } else if (change === "child-replacement") {
          expect(await fs.readFile(path.join(child, "keep"), "utf8")).toBe("replacement");
          expect(fsSync.statSync(`${child}.original`).isDirectory()).toBe(true);
        }
      },
    );

    it.runIf(process.platform !== "win32").each(["mode", "owner"] as const)(
      "rejects an untrusted final child descriptor %s observation before registration", async (change) => {
        const base = await tempRoot("fs-safe-workspace-final-descriptor-");
        const grandparent = path.join(base, "grandparent");
        const rootDir = path.join(grandparent, "parent", "root");
        await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
        let childFd: number | undefined;
        let finalAncestryStarted = false;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (isChild(args[0])) childFd = fd;
          return fd;
        });
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (name === grandparent && childFd !== undefined) finalAncestryStarted = true;
          return stat;
        });
        const fstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
          const stat = fstat(fd, options);
          if (fd === childFd && finalAncestryStarted) {
            if (change === "mode") {
              (stat as { mode: number | bigint }).mode = typeof stat.mode === "bigint"
                ? stat.mode | 0o022n
                : stat.mode | 0o022;
            } else {
              (stat as { uid: number | bigint }).uid = typeof stat.uid === "bigint"
                ? BigInt(process.geteuid!()) + 1n
                : process.geteuid!() + 1;
            }
          }
          return stat;
        });
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        await expect(create(rootDir)).rejects.toMatchObject({
          code: change === "mode" ? "insecure-permissions" : "not-owned",
        });
        expect(childFd).toBeDefined();
        expect(finalAncestryStarted).toBe(true);
        expect(register).not.toHaveBeenCalled();
        expect(() => fsSync.fstatSync(childFd!)).toThrowError(
          expect.objectContaining({ code: "EBADF" }),
        );
      },
    );
  });
}
