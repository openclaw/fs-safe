import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractArchive,
  inspectTarArchive,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  readArchiveEntry,
  withStagedArchiveDestination,
} from "../src/archive.js";
import { assertResolvedInsideDestination } from "../src/archive-staging.js";
import { stageArchiveFileForExtraction } from "../src/archive-input.js";
import type { ExtractionDeadline } from "../src/archive-deadline.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import { modeArchive } from "./helpers/archive-modes.js";
import { useTempDirs } from "./helpers/vitest.js";
import { paxNative } from "./helpers/archive-pax-native.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  vi.restoreAllMocks();
});

function deadline(): ExtractionDeadline {
  return {
    signal: new AbortController().signal,
    check() {},
    dispose() {},
  };
}

async function expectInvalidPath(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: "invalid-path" });
}

describe.runIf(process.platform === "win32")("Windows archive namespace aliases", () => {
  it("rejects alternate-stream archive inputs before staging or reading them", async () => {
    const root = await tempRoot("fs-safe-archive-ads-input-");
    const carrier = path.join(root, "carrier");
    const archivePath = `${carrier}:payload.zip`;
    await fs.writeFile(carrier, "carrier");
    await fs.writeFile(archivePath, await modeArchive("zip", [{ path: "value" }]));

    await expectInvalidPath(stageArchiveFileForExtraction({
      archivePath,
      limits: resolveExtractLimits(),
      deadline: deadline(),
    }));
    await expectInvalidPath(readArchiveEntry(archivePath, "value", { kind: "zip", maxBytes: 3 }));
    for (const mode of ["off", "require"] as const) {
      configureFsSafeNative({ mode });
      await expectInvalidPath(extractArchive({ archivePath, destDir: root, kind: "zip" }));
      __resetFsSafeNativeConfigForTest();
    }
    await expectInvalidPath(inspectTarArchive({ archivePath }));
  });

  it.runIf(Boolean(paxNative))("rejects direct native archive aliases before fd or parser work", async () => {
    const alias = "C:\\carrier.tar:payload";
    const limits = resolveTarMeterLimits();
    const signal = new AbortController().signal;
    const expected = { code: "InvalidArg" };
    await expect(Promise.resolve().then(() =>
      paxNative!.inspectArchiveNative(alias, "tar", limits, signal)))
      .rejects.toMatchObject(expected);
    await expect(Promise.resolve().then(() =>
      paxNative!.extractArchiveNative(alias, "tar", -1, [], limits, signal)))
      .rejects.toMatchObject(expected);
    await expect(Promise.resolve().then(() =>
      paxNative!.readArchiveEntryNative(alias, "tar", "value", 1, limits, signal)))
      .rejects.toMatchObject(expected);
  });

  it("preserves archive member validation before source admission", async () => {
    const root = await tempRoot("fs-safe-archive-ads-order-");
    const archivePath = `${path.join(root, "carrier")}:payload.zip`;

    await expect(readArchiveEntry(archivePath, "../escape", { kind: "zip", maxBytes: 1 }))
      .rejects.toMatchObject({ code: "entry-path" });
  });

  it("rejects an alternate-stream canonical archive input", async () => {
    const root = await tempRoot("fs-safe-archive-ads-canonical-");
    const archivePath = path.join(root, "input.zip");
    await fs.writeFile(archivePath, await modeArchive("zip", [{ path: "value" }]));
    vi.spyOn(fsSync.realpathSync, "native").mockReturnValueOnce(`${archivePath}:payload`);

    await expectInvalidPath(readArchiveEntry(archivePath, "value", { kind: "zip", maxBytes: 3 }));
  });

  it("rejects directory-index archive destinations without publishing", async () => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-archive-ads-destination-");
    const archivePath = path.join(root, "input.zip");
    const destination = path.join(root, "destination");
    await fs.writeFile(archivePath, await modeArchive("zip", [{ path: "value" }]));
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, "sentinel"), "unchanged");
    const indexAlias = `${destination}::$INDEX_ALLOCATION`;

    await expectInvalidPath(prepareArchiveDestinationDir(indexAlias));
    await expectInvalidPath(extractArchive({ archivePath, destDir: indexAlias, kind: "zip" }));
    await expect(fs.readdir(destination)).resolves.toEqual(["sentinel"]);
  });

  it("admits an invalid destination before looking up the archive source", async () => {
    const lstat = vi.spyOn(fsSync, "lstatSync");
    await expectInvalidPath(extractArchive({
      archivePath: "C:\\missing.zip",
      destDir: "C:\\destination::$INDEX_ALLOCATION",
      kind: "zip",
    }));
    expect(lstat).not.toHaveBeenCalled();
  });

  it("rejects namespace aliases at each public merge directory boundary", async () => {
    const root = await tempRoot("fs-safe-archive-ads-merge-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.mkdir(source);
    await fs.mkdir(destination);
    await fs.writeFile(path.join(source, "value"), "new");
    await fs.writeFile(path.join(destination, "sentinel"), "unchanged");
    const sourceIndex = `${source}::$INDEX_ALLOCATION`;
    const destinationIndex = `${destination}::$INDEX_ALLOCATION`;

    await expectInvalidPath(mergeExtractedTreeIntoDestination({
      sourceDir: sourceIndex,
      destinationDir: destination,
      destinationRealDir: destination,
    }));
    await expectInvalidPath(mergeExtractedTreeIntoDestination({
      sourceDir: source,
      destinationDir: destinationIndex,
      destinationRealDir: destination,
    }));
    await expectInvalidPath(mergeExtractedTreeIntoDestination({
      sourceDir: source,
      destinationDir: destination,
      destinationRealDir: destinationIndex,
    }));

    await expect(fs.readdir(destination)).resolves.toEqual(["sentinel"]);
  });

  it("rejects a namespace alias returned while canonicalizing a destination", async () => {
    const root = await tempRoot("fs-safe-archive-ads-destination-real-");
    const destination = path.join(root, "destination");
    await fs.mkdir(destination);
    vi.spyOn(fsSync.realpathSync, "native").mockReturnValueOnce(`${destination}::$INDEX_ALLOCATION`);

    await expectInvalidPath(prepareArchiveDestinationDir(destination));
  });

  it.each([
    ["destinationDir", "C:\\destination::$INDEX_ALLOCATION"],
    ["destinationRealDir", "C:\\destination::$INDEX_ALLOCATION"],
    ["relPath", "child:hidden"],
    ["outPath", "C:\\destination\\child:hidden"],
  ] as const)("rejects archive output alias field %s before filesystem access", async (field, alias) => {
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const params = {
      destinationDir: "C:\\destination",
      destinationRealDir: "C:\\destination",
      relPath: "child",
      outPath: "C:\\destination\\child",
      originalPath: "child",
      isDirectory: false,
      [field]: alias,
    };
    await expectInvalidPath(prepareArchiveOutputPath(params));
    expect(lstat).not.toHaveBeenCalled();
  });

  it("rejects a namespace alias returned while canonicalizing an archive output", async () => {
    vi.spyOn(fsSync.realpathSync, "native").mockReturnValue("C:\\destination\\child:hidden");
    await expectInvalidPath(assertResolvedInsideDestination({
      destinationRealDir: "C:\\destination",
      targetPath: "C:\\destination\\child",
      originalPath: "child",
    }));
  });

  it("rejects an archive staging prefix alias before mkdtemp", async () => {
    const root = await tempRoot("fs-safe-archive-prefix-alias-");
    const destination = path.join(root, "destination");
    await fs.mkdir(destination);
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    await expectInvalidPath(withStagedArchiveDestination({
      destinationRealDir: destination,
      stagingDirPrefix: "stage:hidden-",
      run: async () => undefined,
    }));
    expect(mkdtemp).not.toHaveBeenCalled();
  });
});
