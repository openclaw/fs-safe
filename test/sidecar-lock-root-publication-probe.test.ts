import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import * as realpathOwner from "../src/realpath.js";
import { root } from "../src/root.js";
import { sidecarStagingPath } from "../src/sidecar-lock-staging.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { readSidecarLockSnapshot } from "./helpers/sidecar-snapshot.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  vi.restoreAllMocks();
});

it.each(["unlinked", "changed"] as const)(
  "discards a lost read during recognized successor publication (%s)",
  async discardObservation => {
    await checkPublicationProbe(discardObservation, true);
  },
);

it("keeps an unrecognized hardlink terminal during a lost-read probe", async () => {
  await checkPublicationProbe("changed", false);
});

async function checkPublicationProbe(discardObservation: "unlinked" | "changed", recognized: boolean) {
  configureFsSafeNative({ mode: "off" });
  const capability = await root(await tempRoot("sidecar-publication-probe-"));
  const relative = "state.lock", lockPath = path.join(capability.rootReal, relative);
  const stage = recognized ? sidecarStagingPath(lockPath) : `${lockPath}.unrecognized`;
  const outside = path.join(path.dirname(capability.rootReal), "deleted.lock");
  await capability.create(relative, '{"owner":"original"}');
  let armed = false, injected = false;
  let descriptor: import("node:fs/promises").FileHandle | undefined;
  const realpath = realpathSync.native;
  vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
    if (candidate === lockPath && armed) {
      armed = false;
      injected = true;
      fs.unlinkSync(lockPath);
      expect(fs.fstatSync(descriptor!.fd, { bigint: true }).nlink).toBe(0n);
      fs.writeFileSync(lockPath, '{"owner":"successor"}', { flag: "wx" });
      fs.linkSync(lockPath, stage);
      // Windows may resolve the deleted-but-open record outside its old Root.
      return outside;
    }
    return realpath(candidate);
  });
  const realpathAsync = realpathOwner.realpathNative;
  vi.spyOn(realpathOwner, "realpathNative").mockImplementation(async candidate =>
    candidate === lockPath && armed ? realpathSync.native(candidate) : await realpathAsync(candidate));
  __setFsSafeTestHooksForTest({ beforeRootReadFinalFence(candidate, handle) {
    if (candidate !== lockPath) return;
    descriptor = handle;
    armed = true;
    __setFsSafeTestHooksForTest();
  } });
  const parsePayload = vi.fn(JSON.parse);
  const pending = readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardObservation, parsePayload });
  if (recognized) await expect(pending).resolves.toBeNull();
  else await expect(pending).rejects.toMatchObject({ code: "outside-workspace" });
  expect(injected).toBe(true);
  expect(descriptor?.fd).toBe(-1);
  expect(parsePayload).not.toHaveBeenCalled();
  expect(fs.readFileSync(lockPath, "utf8")).toBe('{"owner":"successor"}');
  expect(fs.lstatSync(lockPath).nlink).toBe(2);
  expect(fs.readFileSync(stage, "utf8")).toBe('{"owner":"successor"}');
}
