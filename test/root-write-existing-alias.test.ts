import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, root, type Root } from "../src/index.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const directoryLink = process.platform === "win32" ? "junction" : "dir";
const nativeAvailable = Boolean(loadTestNative("required-env"));
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

const operations = ["write", "create", "atomic-create", "stream-create", "copyIn"] as const;
type Operation = typeof operations[number];
function mutate(safe: Root, operation: Operation, relativePath: string, source: string) {
  const options = { mkdir: false, durable: false };
  if (operation === "copyIn") return safe.copyIn(relativePath, source, options);
  if (operation === "atomic-create") return safe.create(relativePath, "payload", { ...options, atomic: true });
  if (operation === "stream-create") {
    return safe.create(relativePath, (async function* () { yield Buffer.from("payload"); })(), options);
  }
  return safe[operation](relativePath, "payload", options);
}

for (const mode of ["off", "require"] as const) {
  describe.skipIf(process.platform === "win32" || (mode === "require" && !nativeAvailable))(`existing write parent aliases (native ${mode})`, () => {
    async function fixture() {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-existing-alias-");
      const actual = path.join(directory, "actual");
      await fs.mkdir(actual);
      await fs.symlink("actual", path.join(directory, "alias"), directoryLink);
      const source = path.join(directory, "source");
      await fs.writeFile(source, "payload");
      return { directory, actual, source, safe: await root(directory) };
    }

    it.each(operations)("%s follows an existing contained parent without creating directories", async operation => {
      const { directory, actual, source, safe } = await fixture();
      await mutate(safe, operation, "alias/value", source);
      expect(await fs.readFile(path.join(actual, "value"), "utf8")).toBe("payload");
      expect((await fs.lstat(path.join(directory, "alias"))).isSymbolicLink()).toBe(true);
      expect(await fs.readdir(actual)).toEqual(["value"]);
    });

    it.each(operations)("%s keeps missing parents absent", async operation => {
      const { actual, source, safe } = await fixture();
      await expect(mutate(safe, operation, "alias/missing/value", source))
        .rejects.toMatchObject({ code: "not-found", category: "operational" });
      expect(await fs.readdir(actual)).toEqual([]);
    });

    it("keeps explicit parent rejection and canonical denies authoritative", async () => {
      const { actual, safe } = await fixture();
      await expect(safe.write("alias/value", "payload", {
        mkdir: false, mutationSymlinks: "reject",
      })).rejects.toMatchObject({ code: "symlink" });
      await expect(safe.write("alias/value", "payload", {
        mkdir: false, denyMutations: { prefixes: [actual] },
      })).rejects.toMatchObject({ code: "denied-path" });
      expect(await fs.readdir(actual)).toEqual([]);
    });

    it.each(operations)("%s refuses an escaping parent without publishing", async operation => {
      const { directory, source, safe } = await fixture();
      const outside = await tempRoot("fs-safe-existing-alias-outside-");
      await fs.symlink(outside, path.join(directory, "escape"), directoryLink);
      await expect(mutate(safe, operation, "escape/value", source)).rejects.toMatchObject({
        code: "path-alias",
      });
      expect(await fs.readdir(outside)).toEqual([]);
    });
  });
}
