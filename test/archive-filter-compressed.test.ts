import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, type ArchiveEntryFilter } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
// Synthetic USTAR compressed with Python bz2 and Node zstd. Seven members:
// ./pkg//keep='keep', ./pkg//state\cache/ (directory), then 'secret' files at
// pkg\state\cache\backslash, ./pkg/state/./cache/dot, pkg//state///cache//repeated,
// PAX path=./pkg//state/cache/pax and GNU long path=.\pkg//state/./cache\gnu.
const aliases = {
  "tar-zstd": "KLUv/WAAJT0JAPILJR5gR6sDACEqEcVW/C9kwyljTQZijIiCrIwvDEUNrxZEkQ4PYQwZx6j0r3sFA3mKIaBI0V6tv27KewWAhaEGJJPhWWLZRcQmGNqgsQ/ugYUJ1B49uWFHVf2uncqhSGfH1jKtlbZIJBdI15jAGOKgOiY97V6ppZ00bqwnT3kTecqD+THEi/Wb//8Hg+L/Dex2qoiDigI4IDADEQkKWjf9U4GxK2Q85QEglgjIKlCAiEDiwP5jDEa17k6mwe7dH6vSlhSWflCLrAKNCGB3AXIMpswqILibAdmHrrFSoQbgDDR0BGiHAQKHsavoAUZAjQaBxClAC/rVMkZVyGxAj61HCICYgKlMZkInnjTAbEGNaspvCsikgHhTA3o6foWnDYNjL1OTSwI=",
  "tar-bzip2": "QlpoOTFBWSZTWX+43EsAAJxfg8uQQAH/gkTmSsR+795AAAECAAioMAEtqxhJISnjSTbSIekGRoA9QeU8o9T1BpohIHqAAA9QDQAA0Ekpoj1GmgA0GgAyaAAPDzwqvuvsm347OhkaDIGRsynCloIrEki23VGMHvdDZQSgQ3hBjHRZJYUyB6CNJIYEFyACof15LGWh1HbQUm7qQGYsStxWAZxAkEroBGKoEQZAwhInnopp4z0U1wQRspmFnkysEWgmc4ZMQqyVmJBfPiMgBwcAL81WNRIICsQBGEH1nkNPugcWq6rnnawcA4TPQYCwmtQYsJ3qcb8mkmb9MkpxM/bSmZkw2Mc0QxKqyJdLJyOQWbSjGkX5/aUWekkp6a5ubRUEDpcarIG+hzS7HLXDcgZ+tEEQ25oIkPtSVkNbSTwIPyCRxMhL+LuSKcKEg/3G4lg=",
} as const;
// Two files at pkg/state/cache/value and .\pkg//state/./cache\value.
const collisions = {
  "tar-zstd": "KLUv/WAAC60DAILEDxaQtTqI8kwGFbAbZHdnWxX7JJYRd9YpLLCZKZyCarVTEHYnuu75gU0Wxtwe/v/PJP7f6R0KwGQgRZhW16FaLRIA+FEKQAv0gTrGgEoPkCNggA6BjJkBOYNVUFfHL7QhQFnxhtQAkByIAAYNcKxcxqKgCQ==",
  "tar-bzip2": "QlpoOTFBWSZTWZGwmPsAAGLfgMmAQAH9gAEIAARqzd+ACBggAJSEpJ6U8iMEZ6iZNNNo1BKJA0aNAAAAuGh8zViEIKqAjn7ijQpHExIiIoCj/p81veq3kQSI4EGZRCx5cehUZzDRIOLa6DQ5JB5PhycPNz8UkiJv1OVvYrLCYKQmTKYXVCH4u5IpwoSEjYTH2A==",
} as const;

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.skipIf(!paxNative).each(["tar-zstd", "tar-bzip2"] as const)("canonical native %s filter paths", (kind) => {
  let inspectNative: ReturnType<typeof vi.fn>;
  let extractNative: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    configureFsSafeNative({ mode: "require" });
    const native = paxNative!;
    inspectNative = vi.fn(native.inspectArchiveNative.bind(native));
    extractNative = vi.fn(native.extractArchiveNative.bind(native));
    __setNativeLoaderForTest(() => ({
      ...native, inspectArchiveNative: inspectNative, extractArchiveNative: extractNative,
    }));
  });

  async function setup(bytes: string = aliases[kind]) {
    const root = await tempRoot("fs-safe-filter-compressed-");
    const archivePath = path.join(root, "fixture.bin");
    const destDir = path.join(root, "out");
    await fs.writeFile(archivePath, Buffer.from(bytes, "base64"));
    await fs.mkdir(destDir);
    await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
    return { archivePath, destDir, kind, timeoutMs: 10_000 };
  }

  it.each([0, 1])("skips excluded aliases and effective PAX/GNU paths (strip=%s)", async (stripComponents) => {
    const options = await setup();
    const entryFilter = vi.fn<ArchiveEntryFilter>((entry) =>
      entry.path === "pkg/state/cache" || entry.path.startsWith("pkg/state/cache/") ? "skip" : "extract",
    );
    await extractArchive({
      ...options, stripComponents, entryFilter, onFiltered: "skip-entry",
      limits: { maxEntries: 7, maxEntryBytes: 4, maxExtractedBytes: 4 },
    });
    expect(entryFilter.mock.calls).toEqual([
      [{ path: "pkg/keep", kind: "file", size: 4 }],
      [{ path: "pkg/state/cache", kind: "directory", size: 0 }],
      ...["backslash", "dot", "repeated", "pax", "gnu"].map((leaf) => [
        { path: `pkg/state/cache/${leaf}`, kind: "file", size: 6 },
      ]),
    ]);
    expect((await fs.readdir(options.destDir, { recursive: true })).sort()).toEqual(
      (stripComponents ? ["keep", "sentinel"] : ["pkg", "sentinel", path.join("pkg", "keep")]).sort(),
    );
    expect(await fs.readFile(path.join(options.destDir, stripComponents ? "keep" : "pkg/keep"), "utf8")).toBe("keep");
    expect(inspectNative).toHaveBeenCalledTimes(1);
    expect(extractNative).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "reject-archive"] as const)("rejects an exact canonical filter match without publication (%s)", async (onFiltered) => {
    const options = await setup();
    const entryFilter = vi.fn<ArchiveEntryFilter>((entry) => entry.path === "pkg/state/cache" ? "skip" : "extract");
    await expect(extractArchive({ ...options, stripComponents: 1, entryFilter, onFiltered }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-filtered" });
    expect(entryFilter).toHaveBeenNthCalledWith(2, { path: "pkg/state/cache", kind: "directory", size: 0 });
    expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(options.destDir, "sentinel"), "utf8")).toBe("unchanged");
    expect(extractNative).not.toHaveBeenCalled();
  });

  it("rejects filtered duplicate identities before extraction", async () => {
    const options = await setup(collisions[kind]);
    await expect(extractArchive({ ...options, stripComponents: 1, entryFilter: () => "skip", onFiltered: "skip-entry" }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
    expect(extractNative).not.toHaveBeenCalled();
  });

  it("retains physical member counts when every canonical path is stripped", async () => {
    const options = await setup();
    const entryFilter = vi.fn(() => "extract" as const);
    await extractArchive({ ...options, stripComponents: 99, entryFilter, limits: { maxEntries: 7 } });
    expect(entryFilter).not.toHaveBeenCalled();
    expect(extractNative).toHaveBeenCalledTimes(1);
    await expect(extractArchive({ ...options, stripComponents: 99, limits: { maxEntries: 6 } }))
      .rejects.toMatchObject({ name: "ArchiveLimitError", code: "archive-entry-count-exceeds-limit" });
    expect(await fs.readdir(options.destDir)).toEqual(["sentinel"]);
  });
});
