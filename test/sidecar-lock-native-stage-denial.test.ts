import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { fileObservation } from "../src/file-observation.js";
import type { NativeBinding } from "../src/native-binding.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { writeSidecarAtParent } from "../src/sidecar-lock-write.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
});

it.runIf(process.platform !== "win32").each(["open", "foreign-path", "setup", "write"])(
  "attributes only a native Windows staging open denial (%s)", async phase => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-native-stage-denial-");
    const target = path.join(directory, "state.lock");
    const guard = await createAsyncDirectoryGuard(directory, { bigint: true });
    const parent = fs.openSync(directory, fs.constants.O_RDONLY);
    const failure = Object.assign(new Error("native EPERM"), { code: "EPERM" }) as NodeJS.ErrnoException;
    if (phase === "foreign-path") failure.path = path.join(directory, "other");
    let openedPath = "";
    const binding = {
      get closeOwnedFd() { if (phase === "setup") throw failure; return fs.closeSync; },
      openBeneath(_parent: number, relative: string) {
        openedPath = path.join(directory, relative);
        if (phase !== "write") throw failure;
        return { fd: fs.openSync(openedPath, "wx", 0o600) };
      },
    } as unknown as NativeBinding;
    if (phase === "write") vi.spyOn(fs, "write").mockImplementation(() => { throw failure; });
    Object.defineProperty(process, "platform", { value: "win32" });
    const observation = fileObservation();
    try {
      await expect(observation.run(() => writeSidecarAtParent({
        rootPath: directory, relativeParentPath: "", basename: "state.lock", mkdir: false, mode: 0o600,
        input: { kind: "buffer", data: "owner", sidecar: true },
      }, guard, { fd: parent, binding }))).rejects.toBe(failure);
      expect(observation.has(failure, `sidecar-create-denial:${target}`)).toBe(phase === "open");
      expect(failure.path).toBe(phase === "open" ? openedPath : phase === "foreign-path" ? path.join(directory, "other") : undefined);
      if (phase === "setup") expect(openedPath).toBe("");
    } finally { fs.closeSync(parent); }
  },
);
