import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";
import { completeGzip, gzipMember, gzipTar, invalidGzipContainers, sizedGzipMember } from "./helpers/archive-gzip-container.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

describe.each(["off", "require"] as const)("compressed gzip container %s", (mode) => {
  beforeEach(() => {
    configureFsSafeNative({ mode });
    if (mode === "require" && paxNative) __setNativeLoaderForTest(() => paxNative);
  });
  async function setup(bytes: Buffer) {
    const base = await tempRoot("fs-safe-gzip-container-");
    const archivePath = path.join(base, "input.tgz"), destDir = path.join(base, "out");
    await fs.writeFile(archivePath, bytes); await fs.mkdir(destDir);
    return { archivePath, destDir, timeoutMs: 10000 };
  }
  const suite = mode === "require" && !paxNative ? it.skip : it;
  suite.each([0, 1, 511, 512, 513, 10240 - completeGzip.length, 131072])("accepts %i physical zero tail bytes", async (size) => {
    expect(gunzipSync(completeGzip)).toEqual(gzipTar);
    const fixture = await setup(Buffer.concat([completeGzip, Buffer.alloc(size)]));
    await extractArchive(fixture);
    expect((await fs.readdir(fixture.destDir)).sort()).toEqual(["sentinel", "value"]);
    expect(await fs.readFile(path.join(fixture.destDir, "value"), "utf8")).toBe("payload");
    expect(await readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
    expect(await readArchiveEntry(fixture.archivePath, "sentinel", { maxBytes: 3 })).toEqual(Buffer.from("end"));
  });
  suite.each(invalidGzipContainers)("rejects %s without publication or selected bytes", async (_name, bytes) => {
    const fixture = await setup(bytes);
    await expect(extractArchive(fixture)).rejects.toThrow();
    expect(await fs.readdir(fixture.destDir)).toEqual([]);
    await expect(readArchiveEntry(fixture.archivePath, "sentinel", { maxBytes: 3 })).rejects.toThrow();
  });
  suite.each([1, 511, 512, 513, gzipTar.length])("validates concatenated members split at decoded offset %i", async (split) => {
    const bytes = Buffer.concat([gzipMember(gzipTar.subarray(0, split), true), gzipMember(gzipTar.subarray(split)), Buffer.alloc(513)]);
    const fixture = await setup(bytes);
    await extractArchive(fixture);
    expect(await fs.readFile(path.join(fixture.destDir, "sentinel"), "utf8")).toBe("end");
    expect(await readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
  });
  suite.each([65534, 65535, 65536])("accepts an empty following member across physical offset %i without a padding gap", async (size) => {
    const member = sizedGzipMember(gzipTar, size);
    expect(member.length).toBe(size);
    expect(gunzipSync(member)).toEqual(gzipTar);
    const fixture = await setup(Buffer.concat([member, gzipMember(Buffer.alloc(0)), Buffer.alloc(513)]));
    await extractArchive(fixture);
    expect(await fs.readFile(path.join(fixture.destDir, "value"), "utf8")).toBe("payload");
    expect(await readArchiveEntry(fixture.archivePath, "sentinel", { maxBytes: 3 })).toEqual(Buffer.from("end"));
  });
  suite("charges physical container padding against the original archive budget", async () => {
    const bytes = Buffer.concat([completeGzip, Buffer.alloc(10240 - completeGzip.length)]);
    const fixture = await setup(bytes);
    await expect(extractArchive({ ...fixture, limits: { maxArchiveBytes: bytes.length - 1 } }))
      .rejects.toMatchObject({ code: "archive-size-exceeds-limit" });
    expect(await fs.readdir(fixture.destDir)).toEqual([]);
    await extractArchive({ ...fixture, limits: { maxArchiveBytes: bytes.length } });
    expect(await fs.readFile(path.join(fixture.destDir, "value"), "utf8")).toBe("payload");
  });
});

describe.skipIf(process.platform === "win32").each(["off", "require"] as const)("bound system tar stdout %s", (mode) => {
  it.skipIf(mode === "require" && !paxNative)("keeps exact stdout bytes and refuses a wrong directory identity", async () => {
    const { execFileSync, spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    configureFsSafeNative({ mode });
    if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
    const source = await tempRoot("fs-safe-tar-stdout-");
    const names = ["ordinary", "雪.txt", "line\n.txt", "long-" + "a".repeat(130)];
    for (const name of names) await fs.writeFile(path.join(source, name), `exact:${name}`);
    const canonical = await fs.realpath(source), stat = await fs.stat(source, { bigint: true });
    const worker = fileURLToPath(new URL("../scripts/archive-system-tar-worker.cjs", import.meta.url));
    const args = [worker, source, canonical, String(stat.dev), String(stat.ino)];
    const refused = spawnSync(process.execPath, [...args.slice(0, -1), String(stat.ino + 1n)], { timeout: 10000 });
    expect(refused.status).toBe(78); expect(refused.stdout.length).toBe(0);
    const bytes = execFileSync(process.execPath, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const base = await tempRoot("fs-safe-tar-stdout-output-");
    const archivePath = path.join(base, "stdout.tgz"), destDir = path.join(base, "out");
    await fs.writeFile(archivePath, bytes); await fs.mkdir(destDir);
    await extractArchive({ archivePath, destDir, timeoutMs: 10000 });
    expect(await fs.readFile(archivePath)).toEqual(bytes);
    for (const name of names) {
      const expected = Buffer.from(`exact:${name}`);
      expect(await fs.readFile(path.join(destDir, name))).toEqual(expected);
      expect(await readArchiveEntry(archivePath, name, { maxBytes: expected.length })).toEqual(expected);
    }
  });
});
