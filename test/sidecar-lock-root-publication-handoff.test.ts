import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
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

it.each([
  "changed", "publishing", "publishing-completes", "publishing-ancestor", "publishing-other-generation",
  "publishing-root", "publishing-unlinked",
  "unlinked", "root", "still-linked",
] as const)(
  "keeps a publication handoff within %s observation authority",
  async (policy) => {
    configureFsSafeNative({ mode: "off" });
    const capability = await root(await tempRoot("sidecar-publication-handoff-"));
    const relative = policy === "publishing-ancestor" ? "ancestor/parent/state.lock" : "state.lock";
    const lockPath = path.join(capability.rootReal, relative);
    const stage = policy.startsWith("publishing") ? sidecarStagingPath(lockPath) : `${lockPath}.stage`;
    const displaced = `${lockPath}.old`;
    await capability.create(relative, '{"owner":"original"}', { mkdir: true });
    let descriptor: FileHandle | undefined;
    let sampledPublication = false;
    const samplePublication = (observed: { nlink: number | bigint }, bigint?: boolean) => {
      if (!bigint || sampledPublication) return;
      sampledPublication = true;
      expect(observed.nlink).toBe(2n);
      // Either finish publication before fresh verification or retain the
      // second link to test the separate publication-recognition requirement.
      if (policy !== "still-linked" && !policy.startsWith("publishing")) fsSync.unlinkSync(stage);
    };
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
      const observed = fstat(fd, options);
      if (fd === descriptor?.fd) samplePublication(observed, options?.bigint);
      return observed;
    });
    const resolve = capability.resolve.bind(capability);
    let finished = false;
    vi.spyOn(capability, "resolve").mockImplementation(async (...args) => {
      if (policy === "publishing-completes" && sampledPublication && !finished) {
        finished = true;
        fsSync.unlinkSync(stage);
      }
      if (policy === "publishing-other-generation" && sampledPublication && !finished) {
        finished = true;
        fsSync.renameSync(lockPath, `${lockPath}.opened`);
        fsSync.writeFileSync(lockPath, '{"owner":"third"}', { flag: "wx" });
        fsSync.linkSync(lockPath, sidecarStagingPath(lockPath));
      }
      return resolve(...args);
    });
    if (policy === "publishing-ancestor") {
      const stat = capability.stat.bind(capability);
      vi.spyOn(capability, "stat").mockImplementationOnce(async (...args) => {
        const observed = await stat(...args), ancestor = path.join(capability.rootReal, "ancestor");
        await fs.rename(ancestor, `${ancestor}.old`);
        await fs.mkdir(ancestor);
        await fs.rename(path.join(`${ancestor}.old`, "parent"), path.join(ancestor, "parent"));
        finished = true;
        return observed;
      });
    }
    __setFsSafeTestHooksForTest({
      async afterPreOpenLstat(candidate) {
        if (candidate !== lockPath) return;
        __setFsSafeTestHooksForTest();
        await fs.rename(lockPath, displaced);
        await fs.writeFile(lockPath, '{"owner":"successor"}', { flag: "wx" });
        await fs.link(lockPath, stage);
      },
      afterOpen(openedPath, handle) {
        if (openedPath !== lockPath) return;
        descriptor = handle;
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async options => {
          const observed = await stat(options);
          samplePublication(observed, options?.bigint);
          return observed;
        });
      },
    });
    const parsePayload = vi.fn(JSON.parse);
    const pending = policy === "root" || policy === "publishing-root" ? capability.open(relative) : readSidecarLockSnapshot(lockPath, {
      lockRoot: capability, parsePayload,
      discardObservation: policy === "unlinked" || policy === "publishing-unlinked" ? "unlinked" : "changed",
    });
    if (["changed", "publishing", "publishing-completes"].includes(policy)) await expect(pending).resolves.toBeNull();
    else await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
    expect(sampledPublication).toBe(true);
    expect(descriptor?.fd).toBe(-1);
    expect(parsePayload).not.toHaveBeenCalled();
    expect(await fs.readFile(lockPath, "utf8")).toBe(policy === "publishing-other-generation" ? '{"owner":"third"}' : '{"owner":"successor"}');
    expect(await fs.readFile(displaced, "utf8")).toBe('{"owner":"original"}');
    if (["publishing-completes", "publishing-ancestor", "publishing-other-generation"].includes(policy)) expect(finished).toBe(true);
  },
);
