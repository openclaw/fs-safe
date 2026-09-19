import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const failures = [
  { label: "undefined", value: undefined }, { label: "null", value: null },
  { label: "false", value: false }, { label: "+0", value: 0 },
  { label: "-0", value: -0 }, { label: "bigint zero", value: 0n },
  { label: "empty string", value: "" }, { label: "NaN", value: NaN },
  { label: "Error", value: new Error("operational control") },
] as const;

describe.each([false, true])("atomic operational failures, sync=%s", sync => {
  async function run(value: unknown, phase: "refused" | "committed" | "verification") {
    const directory = await tempRoot("fs-safe-atomic-operational-");
    const filePath = path.join(directory, "file");
    await fs.writeFile(filePath, "old");
    let renamed = false, renameCalls = 0, stageFd = -1, closes = 0;
    let stageIdentity: { dev: bigint; ino: bigint } | undefined;
    const options = {
      filePath, content: "new", syncTempFile: false, syncParentDir: false,
      renameMaxRetries: 1, renameRetryBaseDelayMs: 0, copyFallbackOnPermissionError: true,
      beforeRename({ tempPath }: { tempPath: string }) {
        const stat = fsSync.lstatSync(tempPath, { bigint: true });
        stageIdentity = { dev: stat.dev, ino: stat.ino };
      },
    };
    let outcome: { kind: "returned" } | { kind: "threw"; error: unknown };
    try {
      if (sync) {
        replaceFileAtomicSync({ ...options, fileSystem: {
          ...fsSync,
          openSync(...args) { const fd = fsSync.openSync(...args); if (args[1] === "wx") stageFd = fd; return fd; },
          closeSync(fd) { if (fd === stageFd) closes++; fsSync.closeSync(fd); },
          renameSync(from, to) {
            renameCalls++;
            if (phase !== "refused") { fsSync.renameSync(from, to); renamed = true; }
            if (phase !== "verification") throw value;
          },
          lstatSync(candidate, statOptions) {
            if (renamed && phase === "verification" && candidate === filePath) throw value;
            return fsSync.lstatSync(candidate, statOptions as never);
          },
        } });
      } else {
        await replaceFileAtomic({ ...options, beforeRename: async args => { options.beforeRename(args); }, fileSystem: { promises: {
          ...fs,
          async open(...args) {
            const handle = await fs.open(...args);
            if (args[1] === "wx") {
              stageFd = handle.fd; const close = handle.close.bind(handle);
              handle.close = async () => { closes++; await close(); };
            }
            return handle;
          },
          async rename(from, to) {
            renameCalls++;
            if (phase !== "refused") { await fs.rename(from, to); renamed = true; }
            if (phase !== "verification") throw value;
          },
          async lstat(candidate, statOptions) {
            if (renamed && phase === "verification" && candidate === filePath) throw value;
            return await fs.lstat(candidate, statOptions as never);
          },
        } } });
      }
      outcome = { kind: "returned" };
    } catch (error) { outcome = { kind: "threw", error }; }
    expect(outcome.kind).toBe("threw");
    if (outcome.kind !== "threw") throw new Error("Operation unexpectedly returned a success receipt");
    expect(Object.is(outcome.error, value)).toBe(true);
    expect(renameCalls).toBe(1);
    expect(closes).toBe(1);
    expect(stageFd).toBeGreaterThanOrEqual(0);
    expect(await fs.readdir(directory)).toEqual(["file"]);
    expect(await fs.readFile(filePath, "utf8")).toBe(phase === "refused" ? "old" : "new");
    if (phase !== "refused") expect(await fs.lstat(filePath, { bigint: true })).toMatchObject(stageIdentity!);
  }

  describe.each(["refused", "committed", "verification"] as const)("%s", phase => {
    it.each(failures)("preserves $label without losing failure presence", async ({ value }) => {
      await run(value, phase);
    });
  });

  it.each(["throwing", "changing"])("samples a %s code accessor once", async kind => {
    let reads = 0;
    const value = {
      get code() {
        reads++;
        if (kind === "throwing") throw new Error("code accessor failure");
        return reads === 1 ? undefined : "EPERM";
      },
    };
    await run(value, "refused");
    expect(reads).toBe(1);
  });
});
