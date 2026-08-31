import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __loadBundledNativeForTest, type NativeBinding } from "../src/native.js";
import { useTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Native platform jobs build the binding; JavaScript-only jobs skip this proof.
}
const { tempRoot } = useTempDirs();

describe.runIf(native)("native owned-tree removal", () => {
  it("removes nested owned trees and preserves a mismatched replacement", async () => {
    expect(native!.removeOwnedTree).toBeTypeOf("function");
    expect(native!.removeOwnedTreeSync).toBeTypeOf("function");
    const root = await tempRoot("fs-safe-native-owned-tree-");
    const parentFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      for (const mode of ["async", "sync"] as const) {
        const name = `${mode}-owned`;
        const dir = path.join(root, name);
        await fs.mkdir(path.join(dir, "nested"), { recursive: true });
        await fs.writeFile(path.join(dir, "nested", "value"), "owned");
        const dirFd = fsSync.openSync(dir, fsSync.constants.O_RDONLY);
        try {
          const result = mode === "async"
            ? await native!.removeOwnedTree!(parentFd, name, dirFd)
            : native!.removeOwnedTreeSync!(parentFd, name, dirFd);
          expect(result).toMatchObject({ outcome: "removed" });
        } finally {
          fsSync.closeSync(dirFd);
        }
        await expect(fs.lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
      }

      const owned = path.join(root, "raced");
      await fs.mkdir(path.join(owned, "nested"), { recursive: true });
      await fs.writeFile(path.join(owned, "nested", "owned"), "owned");
      const ownedFd = fsSync.openSync(owned, fsSync.constants.O_RDONLY);
      try {
        await fs.rename(owned, path.join(root, "original"));
        await fs.mkdir(path.join(owned, "nested"), { recursive: true });
        await fs.writeFile(path.join(owned, "nested", "keep"), "replacement");
        expect(await native!.removeOwnedTree!(parentFd, "raced", ownedFd))
          .toMatchObject({ outcome: "preserved" });
      } finally {
        fsSync.closeSync(ownedFd);
      }
      expect(await fs.readFile(path.join(owned, "nested", "keep"), "utf8")).toBe("replacement");
      expect(await fs.readFile(path.join(root, "original", "nested", "owned"), "utf8"))
        .toBe("owned");
      if (process.platform === "win32") {
        console.log(JSON.stringify({
          proof: "windows-native-owned-tree",
          nestedAsync: "removed",
          nestedSync: "removed",
          replacementTree: "preserved",
        }));
      }
    } finally {
      fsSync.closeSync(parentFd);
    }
  });
});
