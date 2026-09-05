import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_TAR_MANIFEST_BYTES, resolveTarMeterLimits, tarManifestEntryCost } from "../src/archive-limits.js";
import { TarParserStream } from "../src/archive-tar-wasm.js";
import { manifestMember, nearMaxPath } from "./helpers/archive-admission.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const exec = promisify(execFile);

it.each([
  [{ maxEntries: 0 }, 0],
  [{ maxEntries: 1, maxMetaEntryBytes: 0, maxEntryPathComponents: 0 }, 576],
  [{ maxEntries: 2, maxMetaEntryBytes: 1024, maxEntryPathComponents: 3 }, 3200],
  [{ maxEntries: 2, maxMetaEntryBytes: 300, maxEntryPathComponents: 3 }, 1328],
  [{ maxEntries: Number.MAX_VALUE, maxMetaEntryBytes: Number.MAX_VALUE, maxEntryPathComponents: Number.MAX_VALUE }, MAX_TAR_MANIFEST_BYTES],
])("derives a bounded manifest limit from %j", (options, expected) => {
  expect(resolveTarMeterLimits(options).maxManifestBytes).toBe(expected);
  expect(resolveTarMeterLimits({ ...options, maxArchiveBytes: 0 }).maxManifestBytes).toBe(expected);
  expect(resolveTarMeterLimits({ ...options, maxArchiveBytes: Number.MAX_VALUE }).maxManifestBytes).toBe(expected);
});

it("charges object/string overhead and UTF-8 bytes exactly at the boundary", async () => {
  const name = "pkg/é";
  const cost = 64 + 2 * Buffer.byteLength(name);
  expect(tarManifestEntryCost(name)).toBe(cost);
  for (const maximum of [cost - 1, cost]) {
    let emitted = 0;
    const meter = new TarParserStream({ ...resolveTarMeterLimits(), maxManifestBytes: maximum }, () => { emitted++; });
    meter.resume();
    meter.on("error", () => {});
    const error = await new Promise<Error | null | undefined>((resolve) => meter.end(tarFixture([{ path: name }]), resolve));
    expect(error?.message).toBe(maximum < cost ? "archive manifest size exceeds limit" : undefined);
    expect(emitted).toBe(maximum < cost ? 0 : 1);
  }
});

it.skipIf(!paxNative)("uses the identical UTF-8 cost and boundary during native inspection", async () => {
  const name = "pkg/é";
  const root = await tempRoot("fs-safe-manifest-cost-");
  const archive = path.join(root, "input.tar");
  await fs.writeFile(archive, tarFixture([{ path: name }]));
  const cost = tarManifestEntryCost(name);
  for (const maximum of [cost - 1, cost]) {
    const result = paxNative!.inspectArchiveNative(archive, "tar",
      { ...resolveTarMeterLimits(), maxManifestBytes: maximum }, new AbortController().signal);
    if (maximum < cost) await expect(result).rejects.toThrow("archive-manifest-size-exceeds-limit");
    else await expect(result).resolves.toMatchObject([{ path: name, kind: "file", size: 0 }]);
  }
});

describe.each(["GNU", "PAX"] as const)("streamed %s manifest retention", (extension) => {
  it("stops before emitting the overflowing member or requesting another body", async () => {
    let emitted = 0;
    const limits = resolveTarMeterLimits();
    const meter = new TarParserStream(limits, () => { emitted++; });
    meter.resume();
    meter.on("error", () => {});
    const member = manifestMember(extension);
    const allowed = Math.floor(limits.maxManifestBytes / tarManifestEntryCost(nearMaxPath));
    expect(allowed).toBe(32);
    for (let index = 0; index <= allowed; index++) {
      const error = await new Promise<Error | null | undefined>((resolve) => meter.write(member, resolve));
      if (index < allowed) expect(error).toBeFalsy();
      else expect(error).toMatchObject({ name: "ArchiveLimitError", code: "archive-manifest-size-exceeds-limit" });
    }
    expect(emitted).toBe(allowed);
  });

  it("rejects a compressed path-retention bomb in a 128 MiB JavaScript heap", async () => {
    const root = await tempRoot("fs-safe-manifest-heap-");
    const archivePath = path.join(root, "bomb.tgz");
    const destDir = path.join(root, "out");
    await fs.mkdir(destDir);
    const member = manifestMember(extension);
    function* chunks() {
      for (let i = 0; i < 256; i++) yield member;
      yield Buffer.alloc(1024);
    }
    await pipeline(Readable.from(chunks()), createGzip(), fsSync.createWriteStream(archivePath));
    const script = `
      import { extractArchive } from './dist/archive.js';
      import { configureFsSafeNative } from './dist/config.js';
      configureFsSafeNative({mode: 'off'});
      let filters = 0;
      try {
        await extractArchive({archivePath: process.argv[1], destDir: process.argv[2], kind: 'tar', timeoutMs: 30000,
          entryFilter() { filters++; return 'skip'; }, onFiltered: 'skip-entry'});
        process.exitCode = 1;
      } catch (error) { console.log(JSON.stringify({name: error.name, code: error.code, filters})); }
    `;
    const { stdout } = await exec(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script, archivePath, destDir], { timeout: 40_000 });
    expect(JSON.parse(stdout)).toEqual({ name: "ArchiveLimitError", code: "archive-manifest-size-exceeds-limit", filters: 0 });
    expect(await fs.readdir(destDir)).toEqual([]);
  }, 60_000);
});
