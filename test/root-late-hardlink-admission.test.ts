import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { openRootFile, openRootFileSync, type OpenRootFileSyncParams } from "../src/root-file.js";
import { realpathSync } from "../src/realpath.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { __setFsSafeTestHooksForTest(); vi.restoreAllMocks(); });

for (const operation of ["open", "readText", "readAbsolute", "reader"] as const) {
  for (const phase of ["before-fence", "canonicalization"] as const) {
    it.each(["reject", "allow"] as const)(`${operation} applies %s to a link added during ${phase}`, async (hardlinks) => {
      const directory = await tempRoot("fs-safe-root-late-link-");
      const target = path.join(directory, "value");
      const alias = path.join(directory, "alias");
      fs.writeFileSync(target, "original");
      const scoped = await root(directory, { hardlinks });
      let opened: FileHandle | undefined;
      let read: ReturnType<typeof vi.spyOn> | undefined;
      let readFile: ReturnType<typeof vi.spyOn> | undefined;
      let linked = false;
      const addLink = () => { if (!linked) { fs.linkSync(target, alias); linked = true; } };
      __setFsSafeTestHooksForTest({ beforeRootReadFinalFence(candidate, handle) {
        if (candidate !== target) return;
        opened = handle;
        read = vi.spyOn(handle, "read");
        readFile = vi.spyOn(handle, "readFile");
        if (phase === "before-fence") addLink();
      } });
      const resolve = realpathSync.native.bind(realpathSync);
      vi.spyOn(realpathSync, "native").mockImplementation((candidate, options) => {
        const result = resolve(candidate, options);
        if (opened && String(candidate) === target && phase === "canonicalization") addLink();
        return result;
      });
      let failure: unknown;
      let result: unknown;
      try {
        result = operation === "open" ? await scoped.open("value")
          : operation === "readText" ? await scoped.readText("value")
          : operation === "readAbsolute" ? await scoped.readAbsolute(target)
          : await scoped.reader()(target);
      } catch (error) { failure = error; }
      try {
        expect(linked).toBe(true);
        if (hardlinks === "reject") {
          expect(failure).toMatchObject({ code: "hardlink" });
          expect(result).toBeUndefined();
          expect(read).not.toHaveBeenCalled();
          expect(readFile).not.toHaveBeenCalled();
          expect(opened?.fd).toBe(-1);
        } else {
          expect(failure).toBeUndefined();
          expect(result).toBeDefined();
        }
        expect(fs.readFileSync(alias, "utf8")).toBe("original");
      } finally { await opened?.close(); }
    });
  }
}

for (const mode of ["async", "sync"] as const) {
  it.each([true, false])(`RootFile ${mode} applies rejectHardlinks=%s after canonicalization`, async (rejectHardlinks) => {
    const directory = await tempRoot("fs-safe-root-file-late-link-");
    const target = path.join(directory, "value");
    const alias = path.join(directory, "alias");
    fs.writeFileSync(target, "original");
    let linked = false;
    let closed = 0;
    const resolve = ((candidate: fs.PathLike) => {
      const result = fs.realpathSync(candidate);
      if (String(candidate) === target && !linked) { fs.linkSync(target, alias); linked = true; }
      return result;
    }) as typeof fs.realpathSync;
    resolve.native = fs.realpathSync.native;
    const ioFs: NonNullable<OpenRootFileSyncParams["ioFs"]> = {
      constants: fs.constants, openSync: fs.openSync, fstatSync: fs.fstatSync,
      lstatSync: fs.lstatSync, realpathSync: resolve, readFileSync: fs.readFileSync,
      closeSync(fd) { closed++; fs.closeSync(fd); },
    };
    const params = { absolutePath: target, rootPath: directory, boundaryLabel: "test root", rejectHardlinks, ioFs };
    const result = mode === "sync" ? openRootFileSync(params) : await openRootFile(params);
    try {
      expect(linked).toBe(true);
      if (rejectHardlinks) {
        expect(result).toMatchObject({ ok: false, reason: "validation", error: { code: "hardlink" } });
        expect(closed).toBe(1);
      } else {
        expect(result.ok).toBe(true);
        expect(closed).toBe(0);
      }
      expect(fs.readFileSync(alias, "utf8")).toBe("original");
    } finally { if (result.ok) ioFs.closeSync(result.fd); }
  });
}
