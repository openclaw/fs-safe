import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncReclaimGuardExists } from "../src/file-lock-sync-admission.js";
import { sidecarReclaimGuardExists } from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe.each([
  ["async", sidecarReclaimGuardExists],
  ["sync", syncReclaimGuardExists],
] as const)("%s reclaim guard observation", (_label, exists) => {
  it("treats only absence as available and preserves every occupied file type", async () => {
    const directory = await tempRoot("sidecar-probe-");
    const guard = path.join(directory, "state.reclaim");
    expect(await exists(guard)).toBe(false);
    fs.writeFileSync(guard, "occupied");
    expect(await exists(guard)).toBe(true);
    fs.unlinkSync(guard);
    fs.mkdirSync(guard);
    expect(await exists(guard)).toBe(true);
    fs.rmdirSync(guard);
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(directory, "absent-target"), guard);
      expect(await exists(guard)).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")("preserves a non-directory ancestor error", async () => {
    const directory = await tempRoot("sidecar-probe-parent-");
    const file = path.join(directory, "file");
    fs.writeFileSync(file, "preserved");
    await expect(Promise.resolve().then(() => exists(path.join(file, "guard"))))
      .rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it.each(["EACCES", "EIO"])("propagates %s unchanged", async (code) => {
    const failure = Object.assign(new Error("synthetic observation failure"), { code });
    vi.spyOn(fs, "lstatSync").mockImplementation(() => { throw failure; });
    await expect(Promise.resolve().then(() => exists("guard"))).rejects.toBe(failure);
  });
});
