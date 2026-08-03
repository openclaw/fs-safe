import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { configureFsSafeNative } from "../src/index.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";

const { tempRoot } = useTempDirs();


afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

describe("pinned write fsync compatibility", () => {
  itPosix("treats EPERM from fallback file sync as best effort", async () => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-pinned-write-fsync-eperm-");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "sync").mockRejectedValueOnce(
        Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
      );
      return handle;
    });

    await expect(
      runPinnedWriteHelper({
        rootPath: root,
        relativeParentPath: "",
        basename: "created.txt",
        mkdir: true,
        mode: 0o600,
        overwrite: true,
        input: { kind: "buffer", data: "created", encoding: "utf8" },
      }),
    ).resolves.toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
    await expect(fs.readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe("created");
  });
});
