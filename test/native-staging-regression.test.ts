import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { stageFileInDirectory } from "../src/advanced.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../src/native.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { root } from "../src/root.js";
import { useTempDirs } from "./helpers/vitest.js";

let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = process.platform !== "win32";
} catch {
  // The fallback CI lane intentionally has no binding; native CI builds it first.
}
const { tempRoot } = useTempDirs();
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

describe.runIf(nativeAvailable)("native staged write abort", () => {
  it.each(
    ["root", "public-stage"].flatMap((surface) =>
      [0o644, 0o666, 0o400].map((mode) => ({ surface, mode })),
    ).concat([
      { surface: "native-writer", mode: 0o000 },
      { surface: "public-stage", mode: 0o000 },
    ]),
  )("keeps $surface private until publication with final mode $mode", async ({ surface, mode }) => {
    configureFsSafeNative({ mode: "require" });
    const binding = __loadBundledNativeForTest();
    const directory = await fs.realpath(await tempRoot("fs-safe-stage-mode-boundary-"));
    const beforeRenameModes: number[] = [];
    let firstPublishedFenceMode: number | undefined;
    const observeMode = (name: string) => {
      beforeRenameModes.push(fsSync.lstatSync(path.join(directory, name)).mode & 0o777);
    };
    __setNativeLoaderForTest(() => ({
      ...binding,
      renameReplace(...args) {
        observeMode(args[1]);
        binding.renameReplace(...args);
      },
      renameNoReplace(...args) {
        observeMode(args[1]);
        binding.renameNoReplace(...args);
      },
      stagedFileMatches(...args) {
        if (args[1] === "final" && firstPublishedFenceMode === undefined) {
          firstPublishedFenceMode = fsSync.lstatSync(path.join(directory, "final")).mode & 0o777;
        }
        return binding.stagedFileMatches!(...args);
      },
    }));

    const ownerCheckModes: number[] = [];
    if (surface === "root") {
      const capability = await root(directory);
      await capability.write("final", "private until publication", { mode });
    } else if (surface === "native-writer") {
      await runPinnedWriteHelper({
        rootPath: directory,
        relativeParentPath: "",
        basename: "final",
        mkdir: false,
        mode,
        overwrite: false,
        input: { kind: "buffer", data: "private until publication" },
      });
    } else {
      await using staged = await stageFileInDirectory({
        directory,
        content: "private until publication",
        mode,
      });
      const temporary = path.join(directory, staged.receipt.temporaryBasename);
      ownerCheckModes.push((await fs.lstat(temporary)).mode & 0o777);
      await staged.assertCurrent();
      ownerCheckModes.push((await fs.lstat(temporary)).mode & 0o777);
      const preparedIdentity = staged.receipt.identity;
      const preparedStat = await fs.lstat(temporary, { bigint: true });
      const publication = await staged.publish("final", { overwrite: false });
      expect(publication.staged.identity).toEqual(preparedIdentity);
      expect(publication.staged.identity).toMatchObject({
        mode: 0o600,
        mtimeNs: preparedStat.mtimeNs,
        ctimeNs: preparedStat.ctimeNs,
      });
    }

    const finalPath = path.join(directory, "final");
    expect((await fs.lstat(finalPath)).mode & 0o777).toBe(mode);
    // Read restrictive modes only after observing the actual published mode.
    await fs.chmod(finalPath, 0o600);
    expect(await fs.readFile(finalPath, "utf8")).toBe("private until publication");
    expect(await fs.readdir(directory)).toEqual(["final"]);
    expect(beforeRenameModes).toEqual([0o600]);
    expect(firstPublishedFenceMode).toBe(0o600);
    if (surface === "public-stage") {
      expect(ownerCheckModes).toEqual([0o600, 0o600]);
    }
  });

  it("retains existing POSIX literal basename support in the shared writer", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-stage-literal-");
    for (const basename of ["colon:name", "back\\slash", "control\nname"]) {
      await runPinnedWriteHelper({
        rootPath: directory,
        relativeParentPath: "",
        basename,
        mkdir: false,
        mode: 0o600,
        overwrite: false,
        input: { kind: "buffer", data: "literal" },
      });
      expect(await fs.readFile(path.join(directory, basename), "utf8")).toBe("literal");
    }
  });

  it("removes the unpublished temp from a moved parent and preserves replacement sentinels", async () => {
    configureFsSafeNative({ mode: "require" });
    const base = await tempRoot("fs-safe-stage-abort-");
    const parent = path.join(base, "parent");
    const moved = path.join(base, "moved");
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, "final"), "original final");
    const abort = new Error("stream aborted after parent move");
    let tempName = "";
    const sentinels = new Map<string, Awaited<ReturnType<typeof fs.lstat>>>();
    const stream = Readable.from((async function* () {
      yield Buffer.from("partially written");
      tempName = (await fs.readdir(parent)).find((name) => name !== "final")!;
      expect(await fs.readFile(path.join(parent, tempName), "utf8")).toBe("partially written");
      await fs.rename(parent, moved);
      await fs.mkdir(parent);
      for (const name of [tempName, "final"]) {
        await fs.writeFile(path.join(parent, name), `replacement ${name}`, { mode: 0o640 });
        sentinels.set(name, await fs.lstat(path.join(parent, name)));
      }
      throw abort;
    })());
    await expect(runPinnedWriteHelper({
      rootPath: parent,
      relativeParentPath: "",
      basename: "final",
      mkdir: false,
      mode: 0o600,
      overwrite: true,
      input: { kind: "stream", stream },
    })).rejects.toBe(abort);
    for (const [name, before] of sentinels) {
      expect(await fs.readFile(path.join(parent, name), "utf8")).toBe(`replacement ${name}`);
      expect(await fs.lstat(path.join(parent, name))).toMatchObject({
        dev: before.dev, ino: before.ino, mode: before.mode,
      });
    }
    expect(await fs.readFile(path.join(moved, "final"), "utf8")).toBe("original final");
    expect(await fs.readdir(moved)).toEqual(["final"]);
  });
});
