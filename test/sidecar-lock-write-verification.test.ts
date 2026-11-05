import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { writeSidecarAtParent, SidecarFallbackWriteError } from "../src/sidecar-lock-write.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

it.each([false, true])("cleans a failed JavaScript Root verifier without removing a successor (replacement=%s)", async replacement => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-lock-verifier-");
  const target = path.join(directory, "state.lock");
  const failure = new Error("final Root verification failed");
  const guard = await createAsyncDirectoryGuard(directory, { bigint: true });
  let verified = false;
  const result = await writeSidecarAtParent({
    rootPath: directory, relativeParentPath: "", basename: "state.lock", mode: 0o600, mkdir: false,
    overwrite: false, input: { kind: "buffer", data: '{"owner":"creator"}', sidecar: true },
    async verifyPublished() {
      verified = true;
      expect(await fs.readFile(target, "utf8")).toBe('{"owner":"creator"}');
      if (replacement) {
        await fs.unlink(target);
        await fs.writeFile(target, '{"owner":"successor"}', { flag: "wx" });
      }
      throw failure;
    },
  }, guard).catch(error => error);
  expect(result).toBeInstanceOf(SidecarFallbackWriteError);
  expect(result.failure).toBe(failure);
  expect(verified).toBe(true);
  if (replacement) expect(await fs.readFile(target, "utf8")).toBe('{"owner":"successor"}');
  else expect(await fs.readdir(directory)).toEqual([]);
});

it("preserves a completed record when Root cleanup authority has been revoked", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-lock-verifier-authority-");
  const target = path.join(directory, "state.lock");
  const verification = new Error("verification failed");
  const revoked = new Error("cleanup authority revoked");
  let allowed = true;
  const result = await writeSidecarAtParent({
    rootPath: directory, relativeParentPath: "", basename: "state.lock", mode: 0o600, mkdir: false,
    overwrite: false, input: { kind: "buffer", data: '{"owner":"creator"}', sidecar: true },
    assertBeforeMutation() { if (!allowed) throw revoked; },
    async verifyPublished() { allowed = false; throw verification; },
  }, await createAsyncDirectoryGuard(directory, { bigint: true })).catch(error => error);
  expect(result).toBeInstanceOf(SidecarFallbackWriteError);
  expect(result.failure).toMatchObject({ name: "SuppressedError", error: revoked, suppressed: verification });
  expect(await fs.readFile(target, "utf8")).toBe('{"owner":"creator"}');
});

it.each(["write", "fsync"])("preserves a fallback placeholder when %s fails after authority revocation", async operation => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-placeholder-authority-");
  const target = path.join(directory, "state.lock");
  const failure = new Error("placeholder persistence failed"), revoked = new Error("cleanup authority revoked");
  let allowed = true;
  vi.spyOn(fsSync, "linkSync").mockImplementation(() => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await Reflect.apply(open, fs, args);
    if (operation === "write" && args[0] === target) vi.spyOn(handle, "write").mockImplementation(async () => {
      allowed = false; throw failure;
    });
    return handle;
  });
  const sync = fsSync.fsyncSync;
  vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
    if (operation === "fsync" && fsSync.existsSync(target)) { allowed = false; throw failure; }
    sync(fd);
  });
  const result = await writeSidecarAtParent({
    rootPath: directory, relativeParentPath: "", basename: "state.lock", mode: 0o600, mkdir: false,
    overwrite: false, input: { kind: "buffer", data: '{"owner":"creator"}', sidecar: true },
    assertBeforeMutation() { if (!allowed) throw revoked; },
  }, await createAsyncDirectoryGuard(directory, { bigint: true })).catch(error => error);
  expect(result).toBeInstanceOf(SidecarFallbackWriteError);
  expect(result.failure).toBe(revoked);
  expect(fsSync.existsSync(target)).toBe(true);
  expect(await fs.readdir(directory)).toEqual(["state.lock"]);
});
