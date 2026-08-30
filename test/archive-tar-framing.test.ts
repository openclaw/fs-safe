import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { malformedTarFraming, numericTarFraming, tarBudgetCases } from "./helpers/archive-tar-framing.js";
import { paxArchive, paxHeader } from "./helpers/archive-pax.js";
import { DEFAULT_MAX_ENTRY_BYTES, resolveTarMeterLimits } from "../src/archive-limits.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const member = { path: "value", body: "payload" };
const hidden = tarFixture([{ path: "hidden" }], false);
const invalid = { name: "ArchiveFormatError", code: "archive-header-invalid" };
const canonical = tarFixture([member]);
const physicalEofCases = [
  { label: "zero padding over the canonical prefix ceiling", bytes: Buffer.concat([canonical, Buffer.alloc(513)]), code: "archive-decoded-size-exceeds-limit" },
  { label: "nonzero trailer", bytes: Buffer.concat([canonical, Buffer.from([1])]), code: "archive-header-invalid" },
  { label: "missing second EOF block", bytes: canonical.subarray(0, canonical.length - 512), code: "archive-header-invalid" },
  { label: "hidden header after one zero block", bytes: Buffer.concat([canonical.subarray(0, canonical.length - 512), hidden]), code: "archive-header-invalid" },
] as const;

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const backend of ["off", "auto-missing", "auto", "require"] as const) {
  describe.skipIf((backend === "auto" || backend === "require") && !paxNative)(`raw TAR framing ${backend}`, () => {
    let inspect: ReturnType<typeof vi.fn>;
    let extract: ReturnType<typeof vi.fn>;
    let read: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      configureFsSafeNative({ mode: backend === "auto-missing" ? "auto" : backend });
      if (backend === "auto-missing") __setNativeLoaderForTest(() => { throw new Error("fixture: no native binding"); });
      if (backend === "auto" || backend === "require") {
        const native = paxNative!;
        inspect = vi.fn(native.inspectArchiveNative.bind(native));
        extract = vi.fn(native.extractArchiveNative.bind(native));
        read = vi.fn(native.readArchiveEntryNative.bind(native));
        __setNativeLoaderForTest(() => ({ ...native, inspectArchiveNative: inspect, extractArchiveNative: extract, readArchiveEntryNative: read }));
      }
    });

    async function setup(bytes: Buffer, gzip: boolean) {
      const root = await tempRoot("fs-safe-tar-framing-");
      const archivePath = path.join(root, gzip ? "fixture.tar.gz" : "fixture.tar");
      const destDir = path.join(root, "out");
      await fs.writeFile(archivePath, gzip ? gzipSync(bytes) : bytes);
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      return { archivePath, destDir, timeoutMs: 10_000 };
    }

    it("finishes raw admission before a parser can reject an earlier checksum", async () => {
      const bytes = Buffer.concat([tarFixture([member]), Buffer.from([1])]);
      bytes.fill(0x30, 148, 156);
      const fixture = await setup(bytes, false);
      await expect(extractArchive(fixture)).rejects.toThrow("nonzero data after TAR EOF");
      await expect(readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).rejects.toThrow("nonzero data after TAR EOF");
    });

    it("meters concatenated gzip members as one decoded TAR stream", async () => {
      const bytes = tarFixture([member]);
      const fixture = await setup(bytes, true);
      const split = 1537; // Split the second EOF block across gzip members.
      await fs.writeFile(fixture.archivePath, Buffer.concat([gzipSync(bytes.subarray(0, split)), gzipSync(bytes.subarray(split))]));
      expect(await readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      await fs.writeFile(fixture.archivePath, Buffer.concat([gzipSync(bytes), gzipSync(hidden)]));
      await expect(extractArchive(fixture)).rejects.toThrow("nonzero data after TAR EOF");
      await expect(readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).rejects.toThrow("nonzero data after TAR EOF");
    });

    it.each(["EOF padding", "cumulative metadata"])("caps gzip %s using the derived decoded ceiling", async (kind) => {
      const bytes = kind === "EOF padding"
        ? Buffer.concat([tarFixture([member]), Buffer.alloc(1024 * 1024)])
        : tarFixture(Array.from({ length: 20 }, (_, index) => [
          { path: "LongName", type: "L", body: `name-${index}\0` }, { path: `raw-${index}` },
        ]).flat());
      const fixture = await setup(bytes, true);
      const limits = { maxArchiveBytes: 4096, maxExtractedBytes: 7 };
      expect((await fs.stat(fixture.archivePath)).size).toBeLessThan(limits.maxArchiveBytes);
      const entryFilter = vi.fn(() => "extract" as const);
      await expect(extractArchive({ ...fixture, limits, entryFilter })).rejects.toMatchObject({
        name: "ArchiveLimitError", code: "archive-decoded-size-exceeds-limit",
      });
      expect(entryFilter).not.toHaveBeenCalled();
      expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
    });

    describe.each([false, true])("gzip=%s", (gzip) => {
      it.each([
        ["maxEntryBytes", "archive-entry-extracted-size-exceeds-limit"],
        ["maxExtractedBytes", "archive-extracted-size-exceeds-limit"],
        ["maxMetaEntryBytes", "archive-meta-entry-size-exceeds-limit"],
        ["maxEntries", "archive-entry-count-exceeds-limit"],
      ] as const)("preserves effectively unbounded finite %s without weakening ordinary limits", async (field, code) => {
        const fixture = await setup(tarFixture([paxHeader([["size", "7"]]), member]), gzip);
        const limits = { [field]: Number.MAX_VALUE };
        await extractArchive({ ...fixture, limits });
        expect(await fs.readFile(path.join(fixture.destDir, "value"), "utf8")).toBe("payload");
        if (backend === "auto" || backend === "require") {
          expect(inspect.mock.calls[0][2]).toEqual(resolveTarMeterLimits(limits));
          expect(extract.mock.calls[0][4]).toBe(inspect.mock.calls[0][2]);
        }
        expect(await readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
        await expect(extractArchive({ ...fixture, limits: { [field]: 0 } })).rejects.toMatchObject({ name: "ArchiveLimitError", code });
      });

      it.skipIf(backend === "off" || backend === "auto-missing").each(physicalEofCases)("drains native inspect/extract/read through physical EOF: $label", async ({ bytes, code }) => {
        const fixture = await setup(bytes, gzip);
        const limits = { ...resolveTarMeterLimits(), maxDecodedBytes: canonical.length };
        const signal = new AbortController().signal;
        const directory = await fs.open(fixture.destDir, "r");
        try {
          // Invoke each real N-API pass independently: preflight must not mask
          // an extractor or selected-entry reader that stops at logical EOF.
          await expect(paxNative!.inspectArchiveNative(fixture.archivePath, "tar", limits, 1024 * 1024, signal)).rejects.toThrow(code);
          await expect(paxNative!.extractArchiveNative(fixture.archivePath, "tar", directory.fd, [], limits, signal)).rejects.toThrow(code);
          await expect(paxNative!.readArchiveEntryNative(fixture.archivePath, "tar", "value", 7, limits, signal)).rejects.toThrow(code);
        } finally {
          await directory.close();
        }
        expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
      });

      it.skipIf(backend === "off" || backend === "auto-missing")("defensively clamps direct native limits and rejects malformed numbers", async () => {
        const fixture = await setup(canonical, gzip);
        const limits = {
          maxEntries: Number.MAX_VALUE, maxEntryBytes: Number.MAX_VALUE,
          maxExtractedBytes: Number.MAX_VALUE, maxMetaEntryBytes: Number.MAX_VALUE, maxDecodedBytes: Number.MAX_VALUE,
        };
        const signal = new AbortController().signal;
        const directory = await fs.open(fixture.destDir, "r");
        try {
          expect(await paxNative!.inspectArchiveNative(fixture.archivePath, "tar", limits, 1024, signal)).toMatchObject([{ path: "value", size: 7 }]);
          await expect(paxNative!.extractArchiveNative(fixture.archivePath, "tar", directory.fd, [], limits, signal)).resolves.toBeUndefined();
          expect(await paxNative!.readArchiveEntryNative(fixture.archivePath, "tar", "value", 7, limits, signal)).toEqual(Buffer.from("payload"));
          for (const field of Object.keys(limits)) {
            for (const value of [NaN, Infinity, -Infinity, -1, -0.5]) {
              const malformed = { ...resolveTarMeterLimits(), [field]: value };
              const error = { code: "InvalidArg", message: `${field} is out of range` };
              await expect(Promise.resolve().then(() => paxNative!.inspectArchiveNative(fixture.archivePath, "tar", malformed, 1024, signal))).rejects.toMatchObject(error);
              await expect(Promise.resolve().then(() => paxNative!.extractArchiveNative(fixture.archivePath, "tar", directory.fd, [], malformed, signal))).rejects.toMatchObject(error);
              await expect(Promise.resolve().then(() => paxNative!.readArchiveEntryNative(fixture.archivePath, "tar", "value", 7, malformed, signal))).rejects.toMatchObject(error);
            }
          }
        } finally {
          await directory.close();
        }
      });

      it.skipIf(backend === "off" || backend === "auto-missing").each(physicalEofCases)("does not publish a native plan after a late $label", async ({ bytes, code }) => {
        const fixture = await setup(canonical, gzip);
        let stagedPath: string | undefined;
        extract.mockImplementationOnce(async (...args: Parameters<NonNullable<typeof paxNative>["extractArchiveNative"]>) => {
          stagedPath = args[0];
          expect(args[3]).toEqual([expect.objectContaining({ path: "value", kind: "file", size: 7 })]);
          // Change only the private input between passes to exercise the real
          // extractor's final drain and the public wrapper's failure cleanup.
          await fs.writeFile(stagedPath, gzip ? gzipSync(bytes) : bytes);
          args[4] = { ...args[4], maxDecodedBytes: canonical.length };
          return paxNative!.extractArchiveNative(...args);
        });
        await expect(extractArchive(fixture)).rejects.toMatchObject({
          name: code === "archive-header-invalid" ? "ArchiveFormatError" : "ArchiveLimitError", code,
        });
        expect(extract).toHaveBeenCalledTimes(1);
        expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
        expect(await fs.readFile(path.join(fixture.destDir, "sentinel"), "utf8")).toBe("unchanged");
        await expect(fs.stat(stagedPath!)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.readdir(path.dirname(fixture.destDir))).sort()).toEqual([path.basename(fixture.archivePath), "out"]);

        read.mockImplementationOnce(async (...args: Parameters<NonNullable<typeof paxNative>["readArchiveEntryNative"]>) => {
          await fs.writeFile(args[0], gzip ? gzipSync(bytes) : bytes);
          args[4] = { ...args[4], maxDecodedBytes: canonical.length };
          return paxNative!.readArchiveEntryNative(...args);
        });
        await expect(readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).rejects.toMatchObject({
          name: code === "archive-header-invalid" ? "ArchiveFormatError" : "ArchiveLimitError", code,
        });
        expect(read).toHaveBeenCalledTimes(1);
      });

      it.skipIf(backend === "off" || backend === "auto-missing")("preserves native selected-output and first-match semantics while finishing traversal", async () => {
        const bytes = tarFixture([member, { path: "value", body: "larger ignored duplicate" }, { path: "directory", type: "5" }]);
        const fixture = await setup(bytes, gzip);
        const limits = { ...resolveTarMeterLimits(), maxDecodedBytes: bytes.length };
        const signal = new AbortController().signal;
        const nativeRead = (name: string, maxBytes: number) => paxNative!.readArchiveEntryNative(fixture.archivePath, "tar", name, maxBytes, limits, signal);
        expect(await nativeRead("value", 7)).toEqual(Buffer.from("payload"));
        await expect(nativeRead("value", 6)).rejects.toThrow("archive-entry-extracted-size-exceeds-limit");
        await expect(nativeRead("absent", 7)).rejects.toThrow("archive entry not found: absent");
        await expect(nativeRead("directory", 7)).rejects.toThrow("archive entry is not a file: directory");
        await expect(paxNative!.readArchiveEntryNative(fixture.archivePath, "tar", "value", 7, { ...limits, maxEntries: 1 }, signal)).rejects.toThrow("archive-entry-count-exceeds-limit");
        await fs.writeFile(fixture.archivePath, gzip ? gzipSync(Buffer.concat([bytes, Buffer.from([1])])) : Buffer.concat([bytes, Buffer.from([1])]));
        await expect(nativeRead("value", 6)).rejects.toThrow("archive-entry-extracted-size-exceeds-limit");
        await expect(nativeRead("directory", 7)).rejects.toThrow("archive entry is not a file: directory");
        await expect(nativeRead("absent", 7)).rejects.toThrow("archive-header-invalid");
      });

      it.skipIf(backend === "off" || backend === "auto-missing")("keeps native directory modes private until the physical tail passes", async () => {
        const prefix = tarFixture([{ path: "directory", type: "5", mode: 0o500 }, member]);
        const fixture = await setup(Buffer.concat([prefix, Buffer.from([1])]), gzip);
        const privateDir = path.join(path.dirname(fixture.destDir), "private-stage");
        await fs.mkdir(privateDir, { mode: 0o700 });
        const directory = await fs.open(privateDir, "r");
        try {
          const plan = [
            { index: 0, path: "directory", kind: "directory", size: 0, mode: 0o500 },
            { index: 1, path: "value", kind: "file", size: 7, mode: 0o600 },
          ];
          await expect(paxNative!.extractArchiveNative(fixture.archivePath, "tar", directory.fd, plan, resolveTarMeterLimits(), new AbortController().signal)).rejects.toThrow("archive-header-invalid");
          expect(await fs.readFile(path.join(privateDir, "value"), "utf8")).toBe("payload");
          if (process.platform !== "win32") expect((await fs.stat(path.join(privateDir, "directory"))).mode & 0o777).toBe(0o700);
          expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
        } finally {
          await directory.close();
        }
      });

      it.each(numericTarFraming)("returns the exact public numeric error for $name", async ({ bytes, code }) => {
        const fixture = await setup(bytes, gzip);
        const outcome = (error: { name: string; code: string }) => ({ name: error.name, code: error.code });
        const expected = { name: code === "archive-header-invalid" ? "ArchiveFormatError" : "ArchiveLimitError", code };
        expect(await extractArchive({ ...fixture, limits: { maxEntryBytes: 0 } }).then(() => "accepted", outcome)).toEqual(expected);
        expect(await readArchiveEntry(fixture.archivePath, "value", { maxBytes: 0 }).then(() => "accepted", outcome)).toEqual(expected);
      });

      it.each(tarBudgetCases)("stops at $name before filters, stripping, or a body", async ({ bytes, limits, code }) => {
        const fixture = await setup(bytes, gzip);
        const entryFilter = vi.fn(() => "skip" as const);
        await expect(extractArchive({ ...fixture, limits, stripComponents: 10, entryFilter, onFiltered: "skip-entry" }))
          .rejects.toMatchObject({ name: "ArchiveLimitError", code });
        expect(entryFilter).not.toHaveBeenCalled();
        expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
        if (backend === "auto" || backend === "require") {
          expect(inspect).toHaveBeenCalledWith(expect.any(String), "tar", resolveTarMeterLimits(limits), expect.any(Number), expect.any(AbortSignal));
          expect(extract).not.toHaveBeenCalled();
        }
      });

      it("keeps maxBytes scoped to the selected output, including PAX effective sizes", async () => {
        const fixture = await setup(paxArchive([["size", "700"]], Buffer.alloc(700, 0x61), 1), gzip);
        expect(await readArchiveEntry(fixture.archivePath, "sentinel", { maxBytes: 3 })).toEqual(Buffer.from("end"));
        await expect(readArchiveEntry(fixture.archivePath, "sentinel", { maxBytes: 2 })).rejects.toMatchObject({
          name: "ArchiveLimitError", code: "archive-entry-extracted-size-exceeds-limit",
        });
        expect(await readArchiveEntry(fixture.archivePath, "raw", { maxBytes: 700 })).toEqual(Buffer.alloc(700, 0x61));
        if (backend === "auto" || backend === "require") {
          expect(inspect).toHaveBeenLastCalledWith(expect.any(String), "tar", resolveTarMeterLimits(), expect.any(Number), expect.any(AbortSignal));
          expect(read).toHaveBeenLastCalledWith(expect.any(String), "tar", "raw", 700, resolveTarMeterLimits(), expect.any(AbortSignal));
        }
        const smallFirst = await setup(tarFixture([member, { path: "large", body: Buffer.alloc(1000) }]), gzip);
        expect(await readArchiveEntry(smallFirst.archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
        const overDefault = await setup(tarFixture([member, { path: "large", mutateHeader: (header) => {
          header.write(`${(DEFAULT_MAX_ENTRY_BYTES + 1).toString(8).padStart(11, "0")}\0`, 124, "ascii");
        } }]), gzip);
        await expect(readArchiveEntry(overDefault.archivePath, "value", { maxBytes: 7 })).rejects.toMatchObject({
          name: "ArchiveLimitError", code: "archive-entry-extracted-size-exceeds-limit",
        });
      });

      it.skipIf(backend === "off" || backend === "auto-missing")("enforces budgets again in native extract/read passes with no accepted plan", async () => {
        for (const { bytes, limits, code } of tarBudgetCases) {
          const fixture = await setup(bytes, gzip);
          const directory = await fs.open(fixture.destDir, "r");
          try {
            const signal = new AbortController().signal;
            await expect(paxNative!.extractArchiveNative(fixture.archivePath, "tar", directory.fd, [], resolveTarMeterLimits(limits), signal)).rejects.toThrow(code);
            await expect(paxNative!.readArchiveEntryNative(fixture.archivePath, "tar", "absent", 7, resolveTarMeterLimits(limits), signal)).rejects.toThrow(code);
          } finally {
            await directory.close();
          }
          expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
        }
      });

      it.each(malformedTarFraming)("rejects %s before filtering or publishing", async (_label, bytes) => {
        const fixture = await setup(bytes, gzip);
        const entryFilter = vi.fn(() => "skip" as const);
        await expect(extractArchive({ ...fixture, entryFilter, onFiltered: "skip-entry" })).rejects.toMatchObject(invalid);
        expect(entryFilter).not.toHaveBeenCalled();
        expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel"]);
        expect(await fs.readFile(path.join(fixture.destDir, "sentinel"), "utf8")).toBe("unchanged");
        await expect(readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).rejects.toMatchObject(invalid);
        if (backend === "auto" || backend === "require") {
          expect(inspect).toHaveBeenCalledTimes(2);
          expect(extract).not.toHaveBeenCalled();
          expect(read).not.toHaveBeenCalled();
        }
      });

      it.each([0, 1, 511, 512, 513, 8192])("accepts EOF followed by %i zero padding bytes", async (padding) => {
        const bytes = Buffer.concat([tarFixture([{ path: "directory", type: "5" }, member]), Buffer.alloc(padding)]);
        const fixture = await setup(bytes, gzip);
        await extractArchive(fixture);
        expect(await fs.readFile(path.join(fixture.destDir, "value"), "utf8")).toBe("payload");
        expect((await fs.stat(path.join(fixture.destDir, "directory"))).isDirectory()).toBe(true);
        expect(await readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      });

      it.each(["1", "2"])("keeps zero-size type %s subject to link policy", async (type) => {
        const fixture = await setup(tarFixture([member, { path: "link", type, linkPath: "value" }]), gzip);
        await expect(extractArchive(fixture)).rejects.toMatchObject({ code: "entry-link" });
        await extractArchive({ ...fixture, entryFilter: (entry) => entry.kind === "symlink" ? "skip" : "extract", onFiltered: "skip-entry" });
        expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel", "value"]);
        expect(await readArchiveEntry(fixture.archivePath, "value", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      });

      it.each(["0", "\0", "7"])("preserves payload and zero blocks inside regular type %s", async (type) => {
        const body = Buffer.concat([Buffer.alloc(1024), hidden]);
        const bytes = tarFixture([{ path: "value", body, mutateHeader: (header) => { header[156] = type.charCodeAt(0); } }]);
        const fixture = await setup(bytes, gzip);
        await extractArchive(fixture);
        expect(await readArchiveEntry(fixture.archivePath, "value", { maxBytes: body.length })).toEqual(body);
        expect(await fs.readdir(fixture.destDir)).toEqual(["sentinel", "value"]);
      });

      it("preserves PAX and GNU metadata payloads", async () => {
        const longName = "directory/" + "x".repeat(120);
        const fixture = await setup(tarFixture([
          paxHeader([["path", "renamed"], ["size", "7"]]), member,
          { path: "LongName", type: "L", body: longName + "\0" }, { path: "raw", body: "gnu" },
          { path: "LongLink", type: "K", body: longName + "\0" }, { path: "link", type: "2", linkPath: "raw" },
        ]), gzip);
        await extractArchive({ ...fixture, entryFilter: (entry) => entry.kind === "symlink" ? "skip" : "extract", onFiltered: "skip-entry" });
        expect(await readArchiveEntry(fixture.archivePath, "renamed", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
        expect(await fs.readFile(path.join(fixture.destDir, longName), "utf8")).toBe("gnu");
      });
    });
  });
}
