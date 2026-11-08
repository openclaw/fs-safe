import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" });
  Object.defineProperty(process, "platform", platform);
});

const cases = [false, true].flatMap(windowsFallback =>
  (["root-create", "root-lock", "raw-lock"] as const).flatMap(owner =>
    (["open", "write"] as const).map(phase => ({ windowsFallback, owner, phase }))),
);

it.each(cases)("$owner preserves its $phase error contract (Windows fallback: $windowsFallback)",
  async ({ windowsFallback, owner, phase }) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("root-lock-error-");
    const capability = await root(directory);
    if (windowsFallback) Object.defineProperty(process, "platform", { value: "win32" });
    const failure = Object.assign(new Error(`${phase} failed`), { code: phase === "open" ? "EACCES" : "EIO" });
    const open = fsp.open;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      const flags = args[1];
      const exclusive = typeof flags === "string" ? flags.includes("x") : (flags & fs.constants.O_EXCL) !== 0;
      const target = path.dirname(String(args[0])) === directory && exclusive;
      if (target && phase === "open") throw failure;
      const handle = await Reflect.apply(open, fsp, args);
      if (target && phase === "write") {
        vi.spyOn(handle, "write").mockRejectedValue(failure);
        vi.spyOn(handle, "writeFile").mockRejectedValue(failure);
      }
      return handle;
    });
    const operation = owner === "root-create" ? capability.create("ordinary", "payload")
      : acquireFileLock(path.join(directory, "state"), {
        ...(owner === "root-lock" ? { lockRoot: capability } : {}),
        payload: () => ({ owner: "creator" }), timeoutMs: 0, retry: { retries: 0 },
      });
    if (owner === "raw-lock" || process.platform === "win32") await expect(operation).rejects.toBe(failure);
    else await expect(operation).rejects.toMatchObject({ name: "FsSafeError", code: "invalid-path", cause: failure });
  },
);

it.runIf(process.platform !== "win32")("retains stage persistence and cleanup failures without retrying a Root lock", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("root-lock-error-cleanup-");
  const capability = await root(directory);
  const persistence = Object.assign(new Error("stage sync failed"), { code: "EIO" });
  const cleanup = Object.assign(new Error("stage cleanup failed"), { code: "EACCES" });
  const sync = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (fs.fstatSync(fd).isFile()) throw persistence;
    sync(fd);
  });
  const unlink = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation(pathname => {
    if (path.basename(String(pathname)).startsWith(".fs-safe-lock-")) throw cleanup;
    unlink(pathname);
  });
  let attempts = 0;
  await expect(acquireFileLock(path.join(directory, "state"), {
    lockRoot: capability, payload: () => { attempts += 1; return { owner: "creator" }; },
    timeoutMs: 0, retry: { retries: 2 },
  })).rejects.toMatchObject({
    name: "FsSafeError", code: "invalid-path",
    cause: { name: "SuppressedError", error: cleanup, suppressed: persistence },
  });
  expect(attempts).toBe(1);
  expect(fs.readdirSync(directory)).toEqual([expect.stringMatching(/^\.fs-safe-lock-.*\.tmp$/)]);
});
