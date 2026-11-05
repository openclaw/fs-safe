import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { writeSidecarAtParent, SidecarFallbackWriteError } from "../src/sidecar-lock-write.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => configureFsSafeNative({ mode: "auto" }));

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
