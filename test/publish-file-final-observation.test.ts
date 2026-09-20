import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishFileExclusive, type PublishFileExclusiveStrategy } from "../src/publish-file.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try { __loadBundledNativeForTest(); nativeAvailable = true; } catch {}
const cases: { name: string; mode: "off" | "require"; strategy: PublishFileExclusiveStrategy; phase: string; copy?: boolean }[] = [
  { name: "portable hardlink", mode: "off", strategy: "link-required", phase: "hardlink-verify" },
  { name: "portable copy", mode: "off", strategy: "link-or-copy", phase: "copy-verify", copy: true },
  ...(nativeAvailable ? [
    { name: "native hardlink", mode: "require" as const, strategy: "link-required" as const, phase: "hardlink-verify" },
    { name: "native rename", mode: "require" as const, strategy: "rename-noreplace" as const, phase: "rename-verify" },
  ] : []),
];
afterEach(() => { vi.restoreAllMocks(); __setFsSafeTestHooksForTest(); __resetNativeLoaderForTest(); __resetFsSafeNativeConfigForTest(); });

async function fixture() {
  const directory = await tempRoot("fs-safe-publication-final-");
  const source = path.join(directory, "source"), target = path.join(directory, "target"), saved = path.join(directory, "saved");
  await fs.writeFile(source, "complete bytes");
  await fs.writeFile(path.join(directory, "sentinel"), "unrelated");
  return { directory, source, target, saved };
}

describe.each(cases)("$name final observation", route => {
  describe.each(["rollback", "preserve"] as const)("onSyncFailure=%s", onSyncFailure => {
    it.each(["source", "target"] as const)("rejects a late %s substitution with verification evidence", async changedPath => {
      configureFsSafeNative({ mode: route.mode });
      const f = await fixture();
      const original = await fs.stat(f.source, { bigint: true });
      if (route.copy) vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
      let changed = false;
      __setFsSafeTestHooksForTest({
        async beforePublishDirectorySync() {
          const selected = changedPath === "source" ? f.source : f.target;
          if (changedPath === "target" || route.strategy !== "rename-noreplace") await fs.rename(selected, f.saved);
          await fs.writeFile(selected, "replacement sentinel");
          changed = true;
        },
      });
      let failure: unknown;
      try { await publishFileExclusive({ sourcePath: f.source, targetPath: f.target, strategy: route.strategy, onSyncFailure }); }
      catch (error) { failure = error; }
      const preserveTarget = changedPath === "target" || route.strategy === "rename-noreplace";
      expect(changed).toBe(true);
      expect(failure).toMatchObject({ code: "path-mismatch", details: {
        phase: route.phase, targetCreated: true, cleanup: preserveTarget ? "preserved" : "removed",
      } });
      expect((failure as { details: { directorySync?: unknown } }).details.directorySync).toBeUndefined();
      expect(await fs.readFile(changedPath === "source" ? f.source : f.target, "utf8")).toBe("replacement sentinel");
      if (changedPath === "target" || route.strategy !== "rename-noreplace") expect(await fs.readFile(f.saved, "utf8")).toBe("complete bytes");
      if (changedPath === "source" && route.strategy !== "rename-noreplace") await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      if (route.strategy === "rename-noreplace") {
        if (changedPath === "target") await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
        else expect(await fs.lstat(f.target, { bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino });
      }
      expect(await fs.readFile(path.join(f.directory, "sentinel"), "utf8")).toBe("unrelated");
    });
  });
});

it.skipIf(process.platform === "win32")("renews the target after the actual directory sync completes", async () => {
  configureFsSafeNative({ mode: "off" });
  const f = await fixture();
  const open = fs.open;
  let changed = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.directory) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        await sync();
        if (!changed) { await fs.rename(f.target, f.saved); await fs.writeFile(f.target, "replacement"); changed = true; }
      });
    }
    return handle;
  });
  await expect(publishFileExclusive({ sourcePath: f.source, targetPath: f.target, strategy: "link-required", onSyncFailure: "preserve" })).rejects.toMatchObject({
    code: "path-mismatch", details: { phase: "hardlink-verify", cleanup: "preserved" },
  });
  expect(changed).toBe(true);
  expect(fsSync.readFileSync(f.target, "utf8")).toBe("replacement");
  expect(fsSync.readFileSync(f.saved, "utf8")).toBe("complete bytes");
});

it("keeps a completed copy pinned while retiring it after late verification failure", async () => {
  configureFsSafeNative({ mode: "off" });
  const f = await fixture();
  vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
  const open = fs.open;
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.target && args[1] === "wx+") target = handle;
    return handle;
  });
  __setFsSafeTestHooksForTest({ beforePublishDirectorySync() {
    fsSync.renameSync(f.source, f.saved);
    fsSync.writeFileSync(f.source, "replacement");
  } });
  const rm = fs.rm;
  let observedPinned = false;
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (args[0] === f.target) {
      observedPinned = target !== undefined && target.fd >= 0;
      if (observedPinned) expect(fsSync.fstatSync(target!.fd).isFile()).toBe(true);
    }
    return await rm(...args);
  });
  await expect(publishFileExclusive({ sourcePath: f.source, targetPath: f.target, strategy: "link-or-copy" })).rejects.toMatchObject({
    code: "path-mismatch", details: { phase: "copy-verify", cleanup: "removed" },
  });
  expect(observedPinned).toBe(true);
  expect(target!.fd).toBe(-1);
  expect(await fs.readFile(f.source, "utf8")).toBe("replacement");
  expect(await fs.readFile(f.saved, "utf8")).toBe("complete bytes");
});
