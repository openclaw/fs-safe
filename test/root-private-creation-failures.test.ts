import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { hasPrivateCreationNative } from "./helpers/private-creation-native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const darwin = process.platform === "darwin";
const nativeAvailable = (darwin || process.platform === "win32") && hasPrivateCreationNative();
const cases: { mode: "off" | "require"; atomic: boolean }[] = [
  { mode: darwin ? "require" : "off", atomic: true },
];
if (process.platform === "win32" && nativeAvailable) {
  cases.push({ mode: "require", atomic: true }, { mode: "require", atomic: false });
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

it.skipIf(darwin && !nativeAvailable).each(cases)(
  "reports a preserved private stage as unpublished after admission fails (native $mode, atomic $atomic)",
  async ({ mode, atomic }) => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-private-stage-admission-");
    const files = await root(directory);
    const target = path.join(directory, "requested");
    const failure = Object.assign(new Error("created stage inspection failed"), { code: "EIO" });
    const opened: { handle: FileHandle; fd: number }[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (fsSync.fstatSync(handle.fd).isFile()) opened.push({ handle, fd: handle.fd });
      return handle;
    });

    let temporaryPath: string | undefined;
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((pathname, options) => {
      const stat = lstat(pathname, options);
      const candidate = String(pathname);
      // Wait until creation has a real, single-linked temporary file. Windows
      // first publishes this name from its private directory through a hardlink.
      if (!temporaryPath && path.dirname(candidate) === directory &&
        /^\.fs-safe-.*\.tmp$/.test(path.basename(candidate)) && stat?.isFile() &&
        (stat.nlink === 1 || stat.nlink === 1n)) {
        temporaryPath = candidate;
        throw failure;
      }
      return stat;
    });

    try {
      const error: unknown = await files.create("requested", "complete content", {
        private: true, atomic, durable: "file",
        // Retain the Node stage route while Darwin's ACL inspector is enabled.
        renameIdentity: darwin ? "verify-content-with-lock" : undefined,
      }).catch((cause: unknown) => cause);
      expect(temporaryPath).toBeDefined();
      expect(opened.length).toBeGreaterThan(0);
      for (const { handle, fd } of opened) {
        expect(handle.fd).toBe(-1);
        expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      }
      expect(() => fsSync.lstatSync(target)).toThrow(expect.objectContaining({ code: "ENOENT" }));
      const temporaryBasename = path.basename(temporaryPath!);
      expect(fsSync.readdirSync(directory)).toEqual([temporaryBasename]);
      expect(fsSync.lstatSync(temporaryPath!).nlink).toBe(1);
      expect(fsSync.readFileSync(temporaryPath!)).toEqual(Buffer.alloc(0));
      expect(error).toMatchObject({
        code: "helper-failed",
        details: {
          phase: "prepare",
          publication: { status: "not-published" },
          cleanup: {
            status: "preserved", temporaryBasename, resources: "closed",
            publication: { status: "not-published" },
          },
        },
        cause: {
          details: { publication: { status: "published" }, path: temporaryPath },
        },
      });
      const causes: unknown[] = [];
      for (let cause = error; cause instanceof Error; cause = cause.cause) causes.push(cause);
      expect(causes).toContain(failure);
    } finally {
      for (const { handle } of opened) await handle.close();
    }
  },
  process.platform === "win32" ? 120_000 : 10_000,
);
