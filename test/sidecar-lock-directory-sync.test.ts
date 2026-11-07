import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });
const kinds = ["raw-async", "raw-sync", "root-async", "root-sync"] as const;

it.runIf(process.platform !== "win32").each(kinds.flatMap(kind => ["EACCES", "EINVAL", "ENOTSUP", "EIO"].map(code => ({ kind, code }))))(
  "$kind tolerates only optional directory persistence errors ($code)", async ({ kind, code }) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-directory-sync-");
    const target = path.join(directory, "state"), final = `${target}.lock`;
    const options = { payload: () => ({ owner: "complete" }), ...(kind.startsWith("root") ? { lockRoot: await root(directory) } : {}) };
    const failure = Object.assign(new Error("directory persistence unavailable"), { code });
    const open = fs.openSync, sync = fs.fsyncSync;
    let injected = false;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (code === "EACCES" && args[0] === directory) { injected = true; throw failure; }
      return Reflect.apply(open, fs, args);
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (code !== "EACCES" && fs.fstatSync(fd).isDirectory()) { injected = true; throw failure; }
      sync(fd);
    });
    const acquire = async () => kind.endsWith("async") ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
    if (code === "EIO") {
      await expect(acquire()).rejects.toBe(failure);
      expect(fs.existsSync(final)).toBe(false);
    } else {
      const owner = await acquire();
      try { expect(JSON.parse(fs.readFileSync(final, "utf8"))).toEqual({ owner: "complete" }); }
      finally { await owner.release(); }
    }
    expect(injected).toBe(true);
  },
);

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("locks a real write/search-only directory", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-search-only-lock-");
  const target = path.join(directory, "state");
  fs.chmodSync(directory, 0o300);
  try {
    const owner = await acquireFileLock(target, { payload: () => ({ owner: "complete" }) });
    try { expect(JSON.parse(fs.readFileSync(`${target}.lock`, "utf8"))).toEqual({ owner: "complete" }); }
    finally { await owner.release(); }
  } finally { fs.chmodSync(directory, 0o700); }
});
