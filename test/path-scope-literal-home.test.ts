import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pathScope } from "../src/root-paths.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe("pathScope literal home-like names", () => {
  it.each(["existing", "files"] as const)("%s opens a literal tilde directory", async (method) => {
    const directory = await tempRoot("fs-safe-scope-tilde-");
    await fs.mkdir(path.join(directory, "~"));
    const filename = path.join(directory, "~", "entry.txt");
    await fs.writeFile(filename, "literal");
    const scope = pathScope(directory, { label: "fixture" });
    const expected = { ok: true, paths: [await fs.realpath(filename)] };
    await expect(scope[method](["~/entry.txt"])).resolves.toEqual(expected);
    await expect(scope[method]([filename])).resolves.toEqual(expected);
  });

  it("keeps missing fallbacks beneath the literal tilde directory", async () => {
    const directory = await tempRoot("fs-safe-scope-tilde-");
    await fs.mkdir(path.join(directory, "~"));
    const scope = pathScope(directory, { label: "fixture" });
    await expect(scope.existing(["~/missing.txt"])).resolves.toEqual({
      ok: true,
      paths: [path.join(directory, "~", "missing.txt")],
    });
    expect((await scope.files(["~/missing.txt"])).ok).toBe(false);
  });
});
