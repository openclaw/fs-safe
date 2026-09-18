import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { writeExternalFileWithinRoot, type ExternalFileWriteOptions } from "../src/output.js";
import {
  writeSiblingTempFile,
  writeViaSiblingTempPath,
  type WriteSiblingTempFileOptions,
} from "../src/sibling-temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __cleanupRegisteredTempPathsForTest();
});

function trackedOptions<T extends object>(values: T) {
  const reads = new Map<keyof T, number>();
  const options = {} as T;
  const keys = Object.keys(values) as (keyof T)[];
  for (const key of keys) {
    Object.defineProperty(options, key, {
      enumerable: true,
      get() {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return values[key];
      },
    });
  }
  return { options, reads, expectedReads: new Map(keys.map((key) => [key, 1])) };
}

function forbidCallbackMethodLookup(callback: object) {
  Object.defineProperties(callback, {
    call: { get(): never { throw new Error("callback.call must not be inspected"); } },
    bind: { get(): never { throw new Error("callback.bind must not be inspected"); } },
  });
}

it.each(["workspace", "sibling"] as const)(
  "captures every external-output option before returning control with %s staging",
  async (staging) => {
    const rootDir = await tempRoot("fs-safe-output-snapshot-");
    let produced = "";
    let receiver: unknown;
    const values: ExternalFileWriteOptions<string> = {
      rootDir,
      path: "\u0001",
      staging,
      producerIsolation: "private-directory",
      maxBytes: 8,
      mode: 0o600,
      fallbackFileName: "captured.bin",
      async write(this: unknown, candidate) {
        receiver = this;
        produced = candidate;
        values.mode = 0o644;
        await fs.writeFile(candidate, "original");
        return "captured-result";
      },
    };
    forbidCallbackMethodLookup(values.write);
    const originalWrite = values.write;
    const replacement = vi.fn(async () => "replacement-result");
    const { options, reads, expectedReads } = trackedOptions(values);
    const pending = writeExternalFileWithinRoot(options);
    const entryReads = new Map(reads);
    Object.assign(values, {
      rootDir: path.join(rootDir, "changed-root"),
      path: "changed.bin",
      staging: staging === "workspace" ? "sibling" : "workspace",
      producerIsolation: undefined,
      maxBytes: 0,
      mode: 0o666,
      fallbackFileName: "changed.bin",
      write: replacement,
    });

    const result = await pending;
    expect(entryReads).toEqual(expectedReads);
    expect(reads).toEqual(expectedReads);
    expect(replacement).not.toHaveBeenCalled();
    expect(result).toEqual({ path: path.join(rootDir, "captured.bin"), result: "captured-result" });
    if (staging === "workspace") {
      expect(receiver).toBe(options);
      expect(path.basename(produced)).toBe("captured.bin");
      expect(path.dirname(path.dirname(produced))).not.toBe(rootDir);
    } else {
      expect(receiver).not.toBe(options);
      expect(receiver).toMatchObject({ tempDir: rootDir, write: originalWrite, mode: 0o600 });
      expect(path.basename(produced)).toMatch(/-captured\.bin\.part$/u);
      expect(path.dirname(path.dirname(produced))).toBe(rootDir);
    }
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("original");
    if (process.platform !== "win32") {
      expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
    }
    await expect(fs.readdir(rootDir)).resolves.toEqual(["captured.bin"]);
    await expect(fs.stat(produced)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each([false, true])(
  "captures sibling callbacks, directory policy, and sync policy before mkdir (enabled: %s)",
  async (enabled) => {
    const dir = await tempRoot("fs-safe-sibling-snapshot-");
    if (process.platform !== "win32") await fs.chmod(dir, 0o755);
    const finalPath = path.join(dir, "captured.bin");
    let produced = "";
    let writeReceiver: unknown;
    let resolverReceiver: unknown;
    const syncs: string[] = [];
    const values: WriteSiblingTempFileOptions<string> = {
      dir,
      producerIsolation: undefined,
      dirMode: 0o710,
      chmodDir: enabled,
      tempPrefix: ".captured",
      mode: 0o600,
      syncTempFile: enabled,
      syncParentDir: enabled,
      async writeTemp(this: unknown, candidate) {
        writeReceiver = this;
        await fs.writeFile(candidate, "original");
        produced = candidate;
        return "captured.bin";
      },
      resolveFinalPath(this: unknown, result) {
        resolverReceiver = this;
        return path.join(dir, result);
      },
    };
    const originalWrite = values.writeTemp;
    const originalResolve = values.resolveFinalPath;
    const replacementWrite = vi.fn(async () => "changed.bin");
    const replacementResolve = vi.fn(() => path.join(dir, "changed.bin"));
    const { options, reads, expectedReads } = trackedOptions(values);
    const mkdir = fs.mkdir.bind(fs);
    let mkdirReads: typeof reads | undefined;
    let mkdirMode: unknown;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === dir && mkdirReads === undefined) {
        mkdirReads = new Map(reads);
        mkdirMode = typeof args[1] === "object" ? args[1]?.mode : args[1];
      }
      return await mkdir(...args);
    });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        syncs.push(args[0] === produced ? "file" : "parent");
        await sync();
      });
      return handle;
    });

    const pending = writeSiblingTempFile(options);
    Object.assign(values, {
      dir: path.join(dir, "changed-dir"),
      producerIsolation: "private-directory",
      dirMode: 0o777,
      chmodDir: !enabled,
      tempPrefix: ".changed",
      mode: 0o666,
      syncTempFile: !enabled,
      syncParentDir: !enabled,
      writeTemp: replacementWrite,
      resolveFinalPath: replacementResolve,
    });

    await expect(pending).resolves.toEqual({ filePath: finalPath, result: "captured.bin" });
    expect(mkdirReads).toEqual(expectedReads);
    expect(mkdirMode).toBe(0o710);
    expect(reads).toEqual(expectedReads);
    expect(replacementWrite).not.toHaveBeenCalled();
    expect(replacementResolve).not.toHaveBeenCalled();
    expect(writeReceiver).not.toBe(options);
    expect(writeReceiver).toMatchObject({ tempDir: dir, write: originalWrite, resolveFinalPath: originalResolve });
    expect(resolverReceiver).toBe(writeReceiver);
    expect(path.dirname(produced)).toBe(dir);
    expect(path.basename(produced)).toMatch(/^\.captured\..*\.tmp$/u);
    await expect(fs.readFile(finalPath, "utf8")).resolves.toBe("original");
    await expect(fs.readdir(dir)).resolves.toEqual(["captured.bin"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(dir)).mode & 0o777).toBe(enabled ? 0o710 : 0o755);
      expect((await fs.stat(finalPath)).mode & 0o777).toBe(0o600);
      expect(syncs).toEqual(enabled ? ["file", "parent"] : []);
    } else {
      expect(syncs.filter((kind) => kind === "file")).toEqual(enabled ? ["file"] : []);
    }
  },
);

it.each(["captured.bin", "<>"])(
  "captures private sibling options and retains the public callback receiver for %s",
  async (fileName) => {
    const rootDir = await tempRoot("fs-safe-private-snapshot-");
    const targetPath = path.join(rootDir, fileName);
    const stop = new Error("stop before publishing an unusable target basename");
    let produced = "";
    let receiver: unknown;
    const values: Parameters<typeof writeViaSiblingTempPath>[0] = {
      rootDir,
      targetPath,
      tempPrefix: ".captured-",
      fallbackFileName: "fallback.bin",
      async writeTemp(this: unknown, candidate) {
        receiver = this;
        produced = candidate;
        await fs.writeFile(candidate, "original");
        if (fileName === "<>") throw stop;
      },
    };
    forbidCallbackMethodLookup(values.writeTemp);
    const replacement = vi.fn(async () => {});
    const { options, reads, expectedReads } = trackedOptions(values);
    const pending = writeViaSiblingTempPath(options);
    const entryReads = new Map(reads);
    Object.assign(values, {
      rootDir: path.join(rootDir, "changed-root"),
      targetPath: path.join(rootDir, "changed.bin"),
      tempPrefix: ".changed-",
      fallbackFileName: "changed.bin",
      writeTemp: replacement,
    });

    if (fileName === "<>") {
      await expect(pending).rejects.toBe(stop);
      await expect(fs.readdir(rootDir)).resolves.toEqual([]);
    } else {
      await pending;
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("original");
      await expect(fs.readdir(rootDir)).resolves.toEqual([fileName]);
    }
    expect(entryReads).toEqual(expectedReads);
    expect(reads).toEqual(expectedReads);
    expect(receiver).toBe(options);
    expect(replacement).not.toHaveBeenCalled();
    expect(path.basename(produced)).toMatch(/^\.captured-/u);
    expect(path.basename(produced)).toContain(fileName === "<>" ? "fallback.bin" : fileName);
    await expect(fs.stat(produced)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
