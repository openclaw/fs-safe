import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTarEntryPreflightChecker,
  extractArchive,
  inspectTarArchive,
  type ArchiveEntryFilter,
  type ArchiveExtractLimits,
} from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { unifiedFixture, unicodeNames } from "./helpers/archive-unified.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const filesOnly: ArchiveEntryFilter = ({ kind }) => kind === "file" || kind === "directory" ? "extract" : "skip";

it("preserves structural entry objects in the public preflight checker", async () => {
  class Entry {
    get path() { return "value.txt"; }
    get type() { return "File"; }
    get size() { return 5; }
  }
  const rootDir = await tempRoot("fs-safe-preflight-entry-");
  expect(createTarEntryPreflightChecker({ rootDir })(new Entry())).toBe(true);
});

it.skipIf(!paxNative)("does not start native inspection after timing out during staging's final close", async () => {
  const root = await tempRoot("fs-safe-inspection-close-deadline-");
  const archivePath = path.join(root, "archive.tar");
  await fs.writeFile(archivePath, tarFixture([{ path: "value", body: "original" }]));
  const native = paxNative!;
  const inspectNative = vi.fn(native.inspectArchiveNative.bind(native));
  configureFsSafeNative({ mode: "require" });
  __setNativeLoaderForTest(() => ({ ...native, inspectArchiveNative: inspectNative }));

  const closing = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (args[0] === archivePath) {
      const realClose = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await realClose();
        closing.resolve();
        await releaseClose.promise;
      });
    }
    return handle;
  });
  const realRm = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
    await realRm(...args);
    if (String(args[0]).includes("fs-safe-archive-input-")) cleaned.resolve();
  });

  // Intercept only deadline registration; staging I/O and Vitest's timers stay real.
  const deadlineTimer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, _ms, ...args) => {
    void closing.promise.then(() => callback(...args));
    return {} as ReturnType<typeof setTimeout>;
  });
  const inspection = inspectTarArchive({ archivePath, timeoutMs: 1_000 });
  deadlineTimer.mockRestore();
  const rejection = expect(inspection).rejects.toThrow("inspect tar timed out after 1000ms");
  try {
    await closing.promise;
    await rejection;
    expect(inspectNative).not.toHaveBeenCalled();
  } finally {
    // Join private staging cleanup so the late continuation cannot leak into another test.
    releaseClose.resolve();
    await cleaned.promise;
  }
  expect(inspectNative).not.toHaveBeenCalled();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.runIf(mode === "off" || Boolean(paxNative))(`TAR inspection (${mode})`, () => {
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
    });

    it.each(unicodeNames.flatMap((name) => [false, true].map((gzip) => [name, gzip] as const)))(
      "preserves admitted identity %j and effective payloads (gzip=%s)", async (name, gzip) => {
        const root = await tempRoot("fs-safe-inspection-");
        const fixture = unifiedFixture(name);
        const archivePath = path.join(root, "archive");
        await fs.writeFile(archivePath, gzip ? gzipSync(fixture.bytes) : fixture.bytes);
        const inspected = await inspectTarArchive({ archivePath, timeoutMs: 10_000, entryFilter: filesOnly });
        expect(inspected).toEqual([
          { path: name, kind: "file", size: fixture.payload.length },
          { path: "sentinel", kind: "file", size: 3 },
        ]);
        expect(Object.isFrozen(inspected)).toBe(true);
        expect(inspected.every(Object.isFrozen)).toBe(true);
        // Windows cannot create LF names, but inspection must not rewrite them.
        if (process.platform === "win32" && name.includes("\n")) return;
        const destDir = path.join(root, "destination");
        await fs.mkdir(destDir);
        const observed: Parameters<ArchiveEntryFilter>[0][] = [];
        await extractArchive({ archivePath, destDir, kind: "tar", timeoutMs: 10_000,
          entryFilter: (entry) => { observed.push(entry); return filesOnly(entry); } });
        expect(observed).toEqual(inspected);
        expect(await fs.readFile(path.join(destDir, name))).toEqual(fixture.payload);
        expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("end");
      },
    );

    it("shares canonical directory, strip-zero, and explicit skip policy with extraction", async () => {
      const root = await tempRoot("fs-safe-inspection-policy-");
      const archivePath = path.join(root, "archive.tar");
      await fs.writeFile(archivePath, tarFixture([
        { path: "./", type: "5" },
        { path: "./pkg//", type: "5" },
        { path: "./pkg//value", body: "value" },
        { path: "pkg\\link", type: "2", linkPath: "value" },
      ]));
      await expect(inspectTarArchive({ archivePath, timeoutMs: 10_000, entryFilter: filesOnly }))
        .rejects.toMatchObject({ code: "entry-filtered" });
      const options = { archivePath, timeoutMs: 10_000, entryFilter: filesOnly, onFiltered: "skip-entry" as const };
      const inspected = await inspectTarArchive(options);
      expect(inspected).toEqual([
        { path: "pkg", kind: "directory", size: 0 },
        { path: "pkg/value", kind: "file", size: 5 },
      ]);
      const destDir = path.join(root, "destination");
      await fs.mkdir(destDir);
      await extractArchive({ ...options, destDir });
      expect(await fs.readdir(path.join(destDir, "pkg"))).toEqual(["value"]);
      expect(await fs.readFile(path.join(destDir, "pkg/value"), "utf8")).toBe("value");
    });

    it("returns archive members, not implicit parent directories created during extraction", async () => {
      const root = await tempRoot("fs-safe-inspection-parents-");
      const archivePath = path.join(root, "archive.tar.gz");
      await fs.writeFile(archivePath, gzipSync(tarFixture([{ path: ".hidden/nested/value", body: "value" }])));
      const options = { archivePath, timeoutMs: 10_000, entryFilter: filesOnly };
      expect(await inspectTarArchive(options)).toEqual([{ path: ".hidden/nested/value", kind: "file", size: 5 }]);
      const destDir = path.join(root, "destination");
      await fs.mkdir(destDir);
      await extractArchive({ ...options, destDir });
      expect((await fs.stat(path.join(destDir, ".hidden"))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(destDir, ".hidden/nested"))).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(destDir, ".hidden/nested/value"), "utf8")).toBe("value");
    });

    it.each([
      { name: "hidden traversal", entries: [{ path: ".hidden/../escape", body: "x" }], filterCalls: 0 },
      { name: "hidden collision", entries: [{ path: ".hidden/value" }, { path: ".hidden\\value" }], filterCalls: 1 },
    ])("rejects $name even when the filter skips every member", async ({ entries, filterCalls }) => {
      const root = await tempRoot("fs-safe-inspection-filtered-");
      const archivePath = path.join(root, "archive.tar");
      await fs.writeFile(archivePath, tarFixture(entries));
      const entryFilter = vi.fn<ArchiveEntryFilter>(() => "skip");
      const options = { archivePath, timeoutMs: 10_000, entryFilter, onFiltered: "skip-entry" as const };
      await expect(inspectTarArchive(options)).rejects.toMatchObject({ code: "entry-path" });
      expect(entryFilter).toHaveBeenCalledTimes(filterCalls);
      entryFilter.mockClear();
      const destDir = path.join(root, "destination");
      await fs.mkdir(destDir);
      await expect(extractArchive({ ...options, destDir })).rejects.toMatchObject({ code: "entry-path" });
      expect(entryFilter).toHaveBeenCalledTimes(filterCalls);
      expect(await fs.readdir(destDir)).toEqual([]);
    });

    it.each([
      { name: "traversal", entries: [{ path: "../escape", body: "x" }], code: "entry-path" },
      { name: "collision", entries: [{ path: "dir/value" }, { path: "dir\\value" }], code: "entry-path" },
      { name: "case collision", entries: [{ path: "value" }, { path: "VALUE" }], code: "entry-path" },
      { name: "link", entries: [{ path: "link", type: "2", linkPath: "target" }], code: "entry-filtered" },
      { name: "device", entries: [{ path: "device", type: "3" }], code: "entry-filtered" },
    ])("rejects $name before producing an inspection result or extracted files", async ({ entries, code }) => {
      const root = await tempRoot("fs-safe-inspection-reject-");
      const archivePath = path.join(root, "archive.tar.gz");
      await fs.writeFile(archivePath, gzipSync(tarFixture(entries)));
      const options = { archivePath, timeoutMs: 10_000, entryFilter: filesOnly };
      await expect(inspectTarArchive(options)).rejects.toMatchObject({ code });
      const destDir = path.join(root, "destination");
      await fs.mkdir(destDir);
      await expect(extractArchive({ ...options, destDir })).rejects.toMatchObject({ code });
      expect(await fs.readdir(destDir)).toEqual([]);
    });

    it.each([
      { limits: { maxArchiveBytes: 1 }, code: "archive-size-exceeds-limit" },
      { limits: { maxEntries: 1 }, code: "archive-entry-count-exceeds-limit" },
      { limits: { maxEntryBytes: 2 }, code: "archive-entry-extracted-size-exceeds-limit" },
      { limits: { maxExtractedBytes: 5 }, code: "archive-extracted-size-exceeds-limit" },
      { limits: { maxEntryPathComponents: 1 }, code: "archive-entry-path-components-exceeds-limit" },
    ] satisfies { limits: ArchiveExtractLimits; code: string }[])("enforces $code during inspection", async ({ limits, code }) => {
      const root = await tempRoot("fs-safe-inspection-limit-");
      const archivePath = path.join(root, "archive.tar");
      await fs.writeFile(archivePath, tarFixture([{ path: "nested/a", body: "abc" }, { path: "b", body: "def" }]));
      await expect(inspectTarArchive({ archivePath, timeoutMs: 10_000, limits }))
        .rejects.toMatchObject({ code });
    });

    it.each(["tar tail", "gzip checksum"])("finishes whole-stream admission before policy (%s)", async (fault) => {
      const root = await tempRoot("fs-safe-inspection-framing-");
      const bytes = gzipSync(Buffer.concat([
        tarFixture([{ path: "value", body: "original" }]),
        fault === "tar tail" ? Buffer.from([1]) : Buffer.alloc(0),
      ]));
      if (fault === "gzip checksum") bytes[bytes.length - 8] ^= 1;
      const archivePath = path.join(root, "archive.tar.gz");
      await fs.writeFile(archivePath, bytes);
      const entryFilter = vi.fn<ArchiveEntryFilter>(() => "extract");
      await expect(inspectTarArchive({ archivePath, timeoutMs: 10_000, entryFilter })).rejects.toThrow();
      expect(entryFilter).not.toHaveBeenCalled();
    });
  });
}
