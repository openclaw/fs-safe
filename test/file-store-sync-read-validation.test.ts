import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectFsSafeErrorSync } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { fileStoreSync } from "../src/file-store.js";

const { tempRoot } = useTempDirs();



describe("sync file-store read validation failures", () => {
  it("surfaces directories as filesystem safety errors", async () => {
    const root = await tempRoot("fs-safe-sync-store-validation-");
    await fs.mkdir(path.join(root, "not-a-file"));
    const store = fileStoreSync({ rootDir: root, private: true });

    expectFsSafeErrorSync(() => store.readTextIfExists("not-a-file"), "not-file");
  });

  itPosix("surfaces hardlinks as filesystem safety errors", async () => {
    const root = await tempRoot("fs-safe-sync-store-hardlink-");
    const filePath = path.join(root, "value.txt");
    await fs.writeFile(filePath, "secret");
    fsSync.linkSync(filePath, path.join(root, "alias.txt"));
    const store = fileStoreSync({ rootDir: root, private: true });

    expectFsSafeErrorSync(() => store.readTextIfExists("value.txt"), "hardlink");
  });
});
