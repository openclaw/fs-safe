import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSidecarStages, sidecarPublicationPending, sidecarStagingPath } from "../src/sidecar-lock-staging.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("cleans only dead-owner stages in its target namespace and never the final lock", async () => {
  const dir = await tempRoot("fs-safe-stage-scope-");
  const target = path.join(dir, "state.lock");
  const own = sidecarStagingPath(target);
  const live = sidecarStagingPath(target);
  const unrelated = sidecarStagingPath(path.join(dir, "other.lock"));
  const malformed = `${own}.unrelated`;
  fs.writeFileSync(target, '{"owner":"final"}');
  for (const name of [own, live, unrelated, malformed]) fs.writeFileSync(name, "stage");
  let calls = 0;
  vi.spyOn(process, "kill").mockImplementation(() => {
    // The dead stage is checked twice; the next matching stage remains live.
    if (++calls <= 2) throw Object.assign(new Error("dead"), { code: "ESRCH" });
    return true;
  });
  // Sort enumeration so liveness assertions do not depend on directory order.
  const entries = [own, live, unrelated, malformed, target].map(name => ({ name: path.basename(name) }));
  vi.spyOn(fs, "opendirSync").mockReturnValue({ readSync: () => entries.shift() ?? null, closeSync() {} } as fs.Dir);
  cleanupSidecarStages(target, () => {});
  expect(fs.existsSync(own)).toBe(false);
  for (const name of [live, unrelated, malformed, target]) expect(fs.existsSync(name)).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe('{"owner":"final"}');
  expect(calls).toBe(3);
});

it("removes an abandoned staging hardlink without changing the published owner", async () => {
  const dir = await tempRoot("fs-safe-stage-linked-");
  const target = path.join(dir, "state.lock"), stage = sidecarStagingPath(target);
  fs.writeFileSync(stage, '{"owner":"published"}');
  fs.linkSync(stage, target);
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
  cleanupSidecarStages(target, () => {});
  expect(fs.existsSync(stage)).toBe(false);
  expect(fs.statSync(target).nlink).toBe(1);
  expect(fs.readFileSync(target, "utf8")).toBe('{"owner":"published"}');
});

it("bounds scanning and preserves symlinks and stages with unknown liveness", async () => {
  const dir = await tempRoot("fs-safe-stage-budget-");
  const target = path.join(dir, "state.lock"), unknown = sidecarStagingPath(target);
  fs.writeFileSync(unknown, "unknown owner");
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("unknown"), { code: "EPERM" }); });
  const read = vi.fn(() => ({ name: path.basename(unknown) }));
  const close = vi.fn();
  vi.spyOn(fs, "opendirSync").mockReturnValue({ readSync: read, closeSync: close } as unknown as fs.Dir);
  cleanupSidecarStages(target, () => {});
  expect(read).toHaveBeenCalledTimes(64);
  expect(close).toHaveBeenCalledOnce();
  expect(fs.readFileSync(unknown, "utf8")).toBe("unknown owner");
});

it("propagates revoked mutation authority without removing any stage", async () => {
  const directory = await tempRoot("fs-safe-stage-authority-");
  const target = path.join(directory, "state.lock"), stage = sidecarStagingPath(target);
  fs.writeFileSync(stage, "stage");
  const failure = new Error("authority revoked");
  expect(() => cleanupSidecarStages(target, () => { throw failure; })).toThrow(failure);
  expect(fs.readFileSync(stage, "utf8")).toBe("stage");
});

it.runIf(process.platform !== "win32")("preserves a staging-shaped symlink and its final lock target", async () => {
  const directory = await tempRoot("fs-safe-stage-link-");
  const target = path.join(directory, "state.lock"), stage = sidecarStagingPath(target);
  fs.writeFileSync(target, "live owner");
  fs.symlinkSync(target, stage);
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
  cleanupSidecarStages(target, () => {});
  expect(fs.lstatSync(stage).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe("live owner");
});

it("recognizes publication beyond the cleanup budget without mutating any entry", async () => {
  const directory = await tempRoot("fs-safe-stage-observe-");
  const target = path.join(directory, "state.lock"), stage = sidecarStagingPath(target);
  fs.writeFileSync(stage, "complete");
  fs.linkSync(stage, target);
  const entries = [...Array.from({ length: 80 }, (_, i) => ({ name: `unrelated-${i}` })), { name: path.basename(stage) }];
  vi.spyOn(fs, "opendirSync").mockReturnValue({ readSync: () => entries.shift() ?? null, closeSync() {} } as fs.Dir);
  const remove = vi.spyOn(fs, "unlinkSync");
  expect(sidecarPublicationPending(target)).toBe(true);
  expect(remove).not.toHaveBeenCalled();
  expect(fs.statSync(target).nlink).toBe(2);
});

it("does not mistake a matching stage name with a different identity for publication", async () => {
  const directory = await tempRoot("fs-safe-stage-impostor-");
  const target = path.join(directory, "state.lock"), stage = sidecarStagingPath(target);
  const foreign = path.join(directory, "foreign");
  fs.writeFileSync(foreign, "foreign");
  fs.linkSync(foreign, target);
  fs.writeFileSync(stage, "unrelated stage");
  expect(sidecarPublicationPending(target)).toBe(false);
  expect(fs.readFileSync(target, "utf8")).toBe("foreign");
});
