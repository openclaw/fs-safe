import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import type { NativeBinding } from "../src/native-binding.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { cleanupCreatedSidecar } from "../src/sidecar-lock-retained.js";
import { writeSidecarAtParent } from "../src/sidecar-lock-write.js";
import { verifyRootWritePublication } from "../src/root-write-verification.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
});

it.runIf(process.platform !== "win32").each([false, true])("native Windows creator cleanup reads its record and preserves successors (%s)", async replacement => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-native-creator-cleanup-");
  const final = path.join(directory, "state.lock"), raw = '{"owner":"creator"}';
  const guard = await createAsyncDirectoryGuard(directory, { bigint: true });
  const parent = fs.openSync(directory, fs.constants.O_RDONLY);
  const failure = new Error("retention failed");
  const binding = {
    closeOwnedFd: fs.closeSync,
    openBeneath(_parent: number, name: string, flags: number) { return { fd: fs.openSync(path.join(directory, name), flags, 0o600) }; },
    linkBeneath(_source: number, source: string, _target: number, target: string) { fs.linkSync(path.join(directory, source), path.join(directory, target)); },
    removeStagedFile(_parent: number, name: string, fd: number) {
      const named = fs.lstatSync(path.join(directory, name), { bigint: true }), held = fs.fstatSync(fd, { bigint: true });
      if (named.dev !== held.dev || named.ino !== held.ino) return "preserved";
      fs.unlinkSync(path.join(directory, name)); return "removed";
    },
    rootRemovalStat(_parent: number, name: string) {
      const stat = fs.lstatSync(path.join(directory, name), { bigint: true });
      return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), symlink: stat.isSymbolicLink() };
    },
    rootRemovalUnlink(_parent: number, name: string) { fs.unlinkSync(path.join(directory, name)); },
  } as unknown as NativeBinding;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const result = await writeSidecarAtParent({
      rootPath: directory, relativeParentPath: "", basename: "state.lock", mkdir: false, mode: 0o600,
      input: { kind: "buffer", data: raw, sidecar: true },
      verifyPublished(fd, identity, parentGuard, nativeParent) {
        return verifyRootWritePublication({
          fd, expectedIdentity: identity, parentGuard, nativeParent, verify: async () => {},
          retention: {
            retain() {
              if (replacement) { fs.unlinkSync(final); fs.writeFileSync(final, '{"owner":"successor"}'); }
              throw failure;
            },
            cleanup(owned, retained, expected) { cleanupCreatedSidecar(final, raw, owned, retained, expected); },
          },
        });
      },
    }, guard, { fd: parent, binding }).catch(error => error);
    if (replacement) {
      expect(result).toMatchObject({ name: "SuppressedError", error: { code: "path-mismatch" }, suppressed: failure });
      expect(fs.readFileSync(final, "utf8")).toBe('{"owner":"successor"}');
    } else {
      expect(result).toBe(failure);
      expect(fs.existsSync(final)).toBe(false);
    }
  } finally { fs.closeSync(parent); }
});
