import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { cleanupPinnedFilePath } from "../src/replace-file-temp-owner.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe("pinned failure cleanup authority", () => {
  it.each(["owned", "replacement", "stale-parent", "missing-identity"])(
    "borrows the retained descriptor and handles %s",
    async (scenario) => {
      const directory = await tempRoot("fs-safe-pinned-cleanup-authority-");
      const parent = path.join(directory, "parent");
      await fs.mkdir(parent, { mode: 0o700 });
      const parentGuard = await createAsyncDirectoryGuard(parent, { bigint: true });
      if (scenario === "stale-parent") {
        await fs.rename(parent, path.join(directory, "old-parent"));
        await fs.mkdir(parent, { mode: 0o700 });
      }
      const pathname = path.join(parent, "target");
      const handle = await fs.open(pathname, "wx", 0o600);
      try {
        await handle.writeFile("owned");
        const identity = await handle.stat({ bigint: true });
        if (scenario === "replacement") {
          await fs.rename(pathname, path.join(parent, "saved"));
          await fs.writeFile(pathname, "replacement", { mode: 0o600 });
        }
        const listeners = process.listenerCount("exit");
        await cleanupPinnedFilePath({
          pathname, handle, parentGuard,
          identity: scenario === "missing-identity" ? undefined : identity,
        });
        expect(process.listenerCount("exit")).toBe(listeners);
        expect((await handle.stat({ bigint: true })).ino).toBe(identity.ino);
        if (scenario === "owned") {
          await expect(fs.lstat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(pathname, "utf8")).toBe(scenario === "replacement" ? "replacement" : "owned");
        }
      } finally {
        await handle.close();
      }
    },
  );
});
