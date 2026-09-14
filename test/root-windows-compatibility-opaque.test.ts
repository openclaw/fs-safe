import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

describe.skipIf(process.platform !== "win32")("Windows compatibility opaque pathname identity", () => {
  describe.each(["off", "auto"] as const)("native %s", nativeMode => {
    beforeEach(() => configureFsSafeNative({ mode: nativeMode }));

    it.each(["unchanged", "same bytes", "different bytes", "reopen failure"] as const)(
      "uses strict descriptor proof for %s, without content acceptance", async behavior => {
        const directory = await tempRoot("fs-safe-win-compat-opaque-");
        const target = path.join(directory, "target"), retained = path.join(directory, "retained");
        const safe = await root(directory, { renameIdentity: "verify-content-with-lock" });
        const failure = Object.assign(new Error("opaque target cannot be reopened"), { code: "EACCES" });
        const substituted = behavior === "same bytes" || behavior === "different bytes";
        let opaque = false;
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
          if (destination !== target) return await rename(source, destination);
          await rename(source, substituted ? retained : target);
          if (substituted) await fs.writeFile(target, behavior === "same bytes" ? "payload" : "replacement");
          opaque = true; // Include the finalizer's first pathname observation.
        });
        for (const operation of ["statSync", "lstatSync"] as const) {
          const actual = fsSync[operation].bind(fsSync);
          vi.spyOn(fsSync, operation).mockImplementation(((...args: Parameters<typeof fsSync.statSync>) => {
            const stat = actual(...args);
            if (!opaque || String(args[0]) !== target) return stat;
            return Object.assign(Object.create(stat), {
              dev: typeof stat.dev === "bigint" ? 0n : 0,
              ino: typeof stat.ino === "bigint" ? 0n : 0,
            });
          }) as typeof fsSync.statSync);
        }
        const reopens: FileHandle[] = [];
        const reads = vi.fn();
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (!opaque || args[0] !== target) return await open(...args);
          // Opaque observations must use the existing strict read-only reopen,
          // not the writable handle reserved for definite identity changes.
          expect(typeof args[1]).toBe("number");
          expect(Number(args[1]) & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)).toBe(0);
          if (behavior === "reopen failure") throw failure;
          const handle = await open(...args);
          const unexpectedRead = () => { reads(); throw new Error("strict publication proof must not read bytes"); };
          vi.spyOn(handle, "read").mockImplementation(unexpectedRead);
          vi.spyOn(handle, "readFile").mockImplementation(unexpectedRead);
          reopens.push(handle);
          return handle;
        });
        const writing = safe.write("target", "payload");
        if (substituted) await expect(writing).rejects.toMatchObject({ code: "path-mismatch" });
        else if (behavior === "reopen failure") await expect(writing).rejects.toBe(failure);
        else await expect(writing).resolves.toBeUndefined();
        expect(reads).not.toHaveBeenCalled();
        if (behavior !== "reopen failure") expect(reopens.length).toBeGreaterThan(0);
        expect(reopens.every(handle => handle.fd === -1)).toBe(true);
        vi.restoreAllMocks();
        expect(await fs.readFile(substituted ? retained : target, "utf8")).toBe("payload");
        if (substituted) expect(await fs.readFile(target, "utf8"))
          .toBe(behavior === "same bytes" ? "payload" : "replacement");
        expect((await fs.readdir(directory)).sort()).toEqual(substituted ? ["retained", "target"] : ["target"]);
      },
    );
  });
});
