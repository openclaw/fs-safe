import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { root } from "../src/root.js";
import * as command from "../src/windows-move-command.js";
import { runWindowsMoveFixture } from "./helpers/windows-content-rights.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const names = [
  { label: "lone-high", value: "\ud800" },
  { label: "lone-low", value: "\udc00" },
  { label: "emoji", value: "\ud83d\ude80" },
].flatMap(({ label, value }) => [
  { label, side: "source", sourceName: `source-${value}`, targetName: "target" },
  { label, side: "target", sourceName: "source", targetName: `target-${value}` },
]);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.runIf(process.platform === "win32")("Windows Root.move filename encoding parity", () => {
  it("fails closed when the normal execution policy rejects the fixed driver", async () => {
    configureFsSafeNative({ mode: "off" });
    vi.stubEnv("PSExecutionPolicyPreference", "Restricted");
    const directory = await tempRoot("fs-safe-win-move-execution-policy-");
    await fs.writeFile(path.join(directory, "source"), "payload");
    const scoped = await root(directory);
    const dispatch = vi.spyOn(command, "moveWindowsMetadataNoReplaceSync");
    await expect(scoped.move("source", "target")).rejects.toMatchObject({
      code: "helper-failed", details: { commit: "unknown" },
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(directory, "source"), "utf8")).toBe("payload");
    await expect(fs.lstat(path.join(directory, "target"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 35_000);

  it.each(names)("preserves $label in the $side filename with native require and command off", async ({ sourceName, targetName }) => {
    // A real native baseline is required; a missing build must fail this proof.
    const native = __loadBundledNativeForTest();
    __setNativeLoaderForTest(() => native);
    const dispatch = vi.spyOn(command, "moveWindowsMetadataNoReplaceSync");
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    for (const mode of ["require", "off"] as const) {
      configureFsSafeNative({ mode });
      dispatch.mockClear();
      const temporary = await tempRoot("fs-safe-win-move-encoding-");
      const directory = path.join(temporary, "root-\ud800");
      await fs.mkdir(directory);
      const sourceRelative = "incoming-\ud800", targetRelative = "outgoing-\udc00";
      const sourceParent = path.join(directory, sourceRelative), targetParent = path.join(directory, targetRelative);
      await fs.mkdir(sourceParent); await fs.mkdir(targetParent);
      const sourcePath = path.join(sourceParent, sourceName), targetPath = path.join(targetParent, targetName);
      try {
        await fs.writeFile(sourcePath, "filename encoding payload", { mode: 0o640 });
        const before = await fs.stat(sourcePath, { bigint: true });
        const scoped = await root(directory);
        await scoped.move(`${sourceRelative}/${sourceName}`, `${targetRelative}/${targetName}`);
        expect(dispatch).toHaveBeenCalledTimes(mode === "off" ? 1 : 0);
        expect(await fs.stat(targetPath, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode, nlink: 1n });
        expect(await fs.readFile(targetPath, "utf8")).toBe("filename encoding payload");
        await expect(fs.lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readdir(sourceParent)).toEqual([]);
        expect(await fs.readdir(targetParent)).toEqual([Buffer.from(targetName, "utf8").toString("utf8")]);
      } finally {
        // A failing raw UTF-16 target may be unaddressable through Node's
        // UTF-8 path conversion; the fixture enumerates and removes it in .NET.
        runWindowsMoveFixture({ operation: "remove-tree", path: temporary });
      }
    }
  }, 125_000);
});
