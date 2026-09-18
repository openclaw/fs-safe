import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive } from "../src/archive.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

async function fixture(label: string, replaceSentinel = false) {
  const root = await tempRoot(label);
  const archivePath = path.join(root, "fixture.zip");
  const destDir = path.join(root, "destination");
  await fs.mkdir(destDir);
  await fs.writeFile(path.join(destDir, "a-sentinel.txt"), "original");
  const zip = new JSZip();
  if (replaceSentinel) zip.file("a-sentinel.txt", "replacement");
  zip.file("z-entry.txt", "published");
  await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return { archivePath, destDir };
}

function injectDefensiveFallbackClose(failure?: Error, failOutputHandle = 1) {
  const realOpen = fs.open.bind(fs);
  const state = { outputHandles: 0, closeCalls: 0, outputPaths: [] as string[] };
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const flags = Number(args[1]);
    if (
      !path.basename(String(args[0])).startsWith(".fs-safe-stream.") ||
      (flags & fsConstants.O_WRONLY) === 0 ||
      (flags & fsConstants.O_CREAT) === 0 ||
      (flags & fsConstants.O_EXCL) === 0
    ) return handle;

    state.outputHandles++;
    state.outputPaths.push(String(args[0]));
    const outputHandle = state.outputHandles;
    let handleCloseCalls = 0;
    handle.createWriteStream = () => fsSync.createWriteStream(String(args[0]), {
      fd: handle.fd,
      autoClose: false,
      emitClose: false,
    });
    const close = handle.close.bind(handle);
    handle.close = async () => {
      state.closeCalls++;
      handleCloseCalls++;
      if (failure && outputHandle === failOutputHandle && handleCloseCalls === 1) {
        // Model an ambiguous close result without leaking a real descriptor if the
        // regression is run against the old swallowing behavior.
        await close();
        throw failure;
      }
      await close();
    };
    return handle;
  });
  return state;
}

describe("portable ZIP output fallback close", () => {
  it("propagates a fallback close rejection without publishing staged entries", async () => {
    const { archivePath, destDir } = await fixture("fs-safe-archive-close-failure-", true);
    const failure = Object.assign(new Error("injected ZIP fallback close failure"), { code: "EIO" });
    // An ordinary FileHandle stream auto-closes. This real numeric-fd stream
    // writes the same descriptor without retaining the FileHandle, and disables
    // auto-close/close emission only to exercise the post-pipeline fallback.
    const state = injectDefensiveFallbackClose(failure, 2);

    await expect(extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }))
      .rejects.toBe(failure);

    expect({ outputHandles: state.outputHandles, closeCalls: state.closeCalls })
      .toEqual({ outputHandles: 2, closeCalls: 3 });
    await expect(fs.readFile(path.join(destDir, "a-sentinel.txt"), "utf8"))
      .resolves.toBe("original");
    await expect(fs.readdir(destDir)).resolves.toEqual(["a-sentinel.txt"]);
    for (const stagingDir of new Set(state.outputPaths.map((outputPath) => path.dirname(outputPath)))) {
      await expect(fs.stat(stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("publishes normally when the defensive fallback close succeeds", async () => {
    const { archivePath, destDir } = await fixture("fs-safe-archive-close-success-");
    const state = injectDefensiveFallbackClose();

    await expect(extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }))
      .resolves.toBeUndefined();

    expect({ outputHandles: state.outputHandles, closeCalls: state.closeCalls })
      .toEqual({ outputHandles: 1, closeCalls: 1 });
    await expect(fs.readFile(path.join(destDir, "z-entry.txt"), "utf8"))
      .resolves.toBe("published");
    await expect(fs.readFile(path.join(destDir, "a-sentinel.txt"), "utf8"))
      .resolves.toBe("original");
  });
});
