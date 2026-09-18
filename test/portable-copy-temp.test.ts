import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTree, createCloneSource, probeTreeClone, readCloneFileMetadata } from "../src/copy.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { tempWorkspace, tempWorkspaceSync, withTempWorkspace, withTempWorkspaceSync } from "../src/temp.js";
import { tempFile } from "../src/temp-target.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

beforeEach(() => {
  __resetNativeFallbackWarningsForTest();
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeFallbackWarningsForTest();
});

function unavailable(mode: "off" | "missing" | "capability") {
  configureFsSafeNative({ mode: mode === "off" ? "off" : "auto" });
  const loader = vi.fn(() => {
    if (mode === "capability") return { closeOwnedFd() {} } as unknown as NativeBinding;
    throw new Error("optional native package missing");
  });
  __setNativeLoaderForTest(loader);
  return loader;
}

describe.each(["off", "missing", "capability"] as const)("portable operations with native %s", (mode) => {
  it("creates an exclusive ordinary clone source and independent copy", async () => {
    const loader = unavailable(mode);
    const parent = await tempRoot("fs-safe-portable-clone-");
    const source = path.join(parent, "source");
    const target = path.join(parent, "target");
    await expect(createCloneSource(source)).resolves.toBeUndefined();
    expect(fsSync.lstatSync(source).isDirectory()).toBe(true);
    expect(probeTreeClone(parent)).toBeUndefined();
    await fs.writeFile(path.join(source, "payload"), "source bytes");
    await expect(createCloneSource(source)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(copyTree(source, target, { clone: "always" })).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(target, "payload"), "utf8")).toBe("source bytes");
    await fs.writeFile(path.join(target, "payload"), "independent bytes");
    expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("source bytes");
    expect(loader).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    const warnings = vi.mocked(process.emitWarning).mock.calls.filter(([text]) =>
      typeof text === "string" && text.startsWith("directory cloning "));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).not.toContain(parent);
  });

  it("validates clone metadata inputs and returns one unavailable observation per entry", async () => {
    unavailable(mode);
    const parent = await tempRoot("fs-safe-portable-metadata-");
    const files = [path.join(parent, "one"), path.join(parent, "two")];
    await expect(readCloneFileMetadata(files)).resolves.toEqual([undefined, undefined]);
    await expect(readCloneFileMetadata([files[0]!, "relative"])).rejects.toMatchObject({ code: "invalid-path" });
    expect(() => probeTreeClone("relative")).toThrowError(expect.objectContaining({ code: "invalid-path" }));
  });

  it("reports guarded cleanup for all workspace forms and retained temp files", async () => {
    unavailable(mode);
    const rootDir = await tempRoot("fs-safe-portable-cleanup-");
    const options = { rootDir, prefix: "portable", cleanupSafety: "require-bounded" as const };
    const workspace = await tempWorkspace(options);
    expect(workspace.cleanupMechanism).toBe("guarded-path");
    await fs.writeFile(path.join(workspace.dir, "owned"), "bytes");
    expect(await workspace.cleanup()).toBe("removed");
    expect(await workspace.cleanup()).toBe("missing");
    const sync = tempWorkspaceSync(options);
    expect(sync.cleanupMechanism).toBe("guarded-path");
    fsSync.writeFileSync(path.join(sync.dir, "owned"), "bytes");
    expect(sync.cleanup()).toBe("removed");
    await withTempWorkspace(options, async (scoped) => {
      expect(scoped.cleanupMechanism).toBe("guarded-path");
      await fs.writeFile(path.join(scoped.dir, "owned"), "bytes");
    });
    withTempWorkspaceSync(options, (scoped) => {
      expect(scoped.cleanupMechanism).toBe("guarded-path");
      fsSync.writeFileSync(path.join(scoped.dir, "owned"), "bytes");
    });
    const file = await tempFile(options);
    expect(file.cleanupMechanism).toBe("guarded-path");
    await fs.writeFile(file.path, "bytes");
    await file.cleanup();
    expect(await fs.readdir(rootDir)).toEqual([]);
    const warnings = vi.mocked(process.emitWarning).mock.calls.filter(([text]) =>
      typeof text === "string" && text.startsWith("bounded temp cleanup "));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).not.toContain(rootDir);
  });
});

it.each(["EACCES", "EIO", "ENOTSUP"])("does not turn a native %s failure into a byte copy", async (code) => {
  configureFsSafeNative({ mode: "auto" });
  const failure = Object.assign(new Error("native copy failure"), { code });
  __setNativeLoaderForTest(() => ({
    closeOwnedFd() {},
    probeTreeClone: () => "xfs",
    cloneTree: async () => { throw failure; },
  }) as unknown as NativeBinding);
  const parent = await tempRoot("fs-safe-portable-copy-error-");
  const source = path.join(parent, "source");
  const target = path.join(parent, "target");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "payload"), "keep");
  await expect(copyTree(source, target, { clone: "always" })).rejects.toBe(failure);
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(source, "payload"), "utf8")).toBe("keep");
});

it("does not merge a partial native clone when the worker reports a capability failure", async () => {
  configureFsSafeNative({ mode: "auto" });
  const parent = await tempRoot("fs-safe-portable-copy-partial-");
  const source = path.join(parent, "source");
  const target = path.join(parent, "target");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "payload"), "source");
  __setNativeLoaderForTest(() => ({
    closeOwnedFd() {},
    probeTreeClone: () => "xfs",
    cloneTree: async () => {
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "payload"), "partial native output");
      throw Object.assign(new Error("unavailable after output"), { code: "CLONE_UNAVAILABLE" });
    },
  }) as unknown as NativeBinding);
  await expect(copyTree(source, target, { clone: "always" })).rejects.toMatchObject({ code: "EEXIST" });
  expect(await fs.readFile(path.join(target, "payload"), "utf8")).toBe("partial native output");
});
