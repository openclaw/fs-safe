import fsSync from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { __cleanupRegisteredTempPathForTest, registerTempPathForExit } from "../src/temp-cleanup.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

it.each([false, true])("preserves a replacement after a missing cleanup observation (directory=%s)", async (directory) => {
  const root = await tempRoot("fs-safe-temp-cleanup-recreated-");
  const tempPath = path.join(root, "entry");
  const displaced = path.join(root, "original");
  const write = (target: string, content: string) => {
    if (directory) fsSync.mkdirSync(target);
    fsSync.writeFileSync(directory ? path.join(target, "payload") : target, content);
  };
  write(tempPath, "owned");
  const unregister = registerTempPathForExit(tempPath, { recursive: directory });
  const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementationOnce(() => {
    fsSync.renameSync(tempPath, displaced);
    // Model a new entry arriving just after the kernel observed the old name absent.
    write(tempPath, "replacement");
    throw Object.assign(new Error("path disappeared"), { code: "ENOENT" });
  });
  try {
    __cleanupRegisteredTempPathForTest(tempPath);
    expect(fsSync.readFileSync(directory ? path.join(tempPath, "payload") : tempPath, "utf8"))
      .toBe("replacement");
    expect(fsSync.readFileSync(directory ? path.join(displaced, "payload") : displaced, "utf8"))
      .toBe("owned");
  } finally {
    lstat.mockRestore();
    unregister();
  }
});
