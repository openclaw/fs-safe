import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  tarBytes,
  tarEntriesBytes,
  zipBytes,
  type TarSizeEncoding,
} from "./helpers/archive-fuzz.js";
import {
  adversarialPath,
  archiveAliasingPathPair,
  propertyParameters,
  WINDOWS_ARCHIVE_PORTABILITY_NAMES,
} from "./helpers/property.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  extractArchive,
  readArchiveEntry,
  type ArchiveExtractLimits,
  type ArchiveKind,
} from "../src/archive.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { isPathInside } from "../src/path.js";

const { tempRoot } = useRealTempDirs();
const DOCUMENTED_REJECTION_CODES = new Set([
  "archive-header-invalid",
  "device-path",
  "entry-path",
  ...Object.values(ARCHIVE_LIMIT_ERROR_CODE),
]);

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // JS-only jobs still run all parser properties except cross-reader equivalence.
}

type Backend = "javascript" | "native";
type ArchiveOutcome = { accepted: true } | { accepted: false; code: string };
const backends = native ? (["javascript", "native"] as const) : (["javascript"] as const);

function useBackend(backend: Backend): void {
  if (backend === "native") {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
  } else {
    configureFsSafeNative({ mode: "off" });
  }
}

async function collectFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else found.push(target);
    }
  }
  await visit(root);
  return found;
}

async function extractOutcome(params: {
  bytes: Buffer;
  kind: ArchiveKind;
  backend: Backend;
  limits?: ArchiveExtractLimits;
}): Promise<ArchiveOutcome> {
  useBackend(params.backend);
  const base = await tempRoot(`fs-safe-${params.kind}-${params.backend}-property-`);
  const archivePath = path.join(base, `input.${params.kind === "zip" ? "zip" : "tar"}`);
  const destination = path.join(base, "destination");
  await fs.writeFile(archivePath, params.bytes);
  await fs.mkdir(destination);
  try {
    await extractArchive({
      archivePath,
      destDir: destination,
      kind: params.kind,
      limits: params.limits,
      timeoutMs: 5_000,
    });
    for (const file of await collectFiles(destination)) {
      expect(isPathInside(destination, file), JSON.stringify({ file })).toBe(true);
      expect(file).not.toBe(destination);
    }
    return { accepted: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    expect(typeof code, String(error)).toBe("string");
    expect(DOCUMENTED_REJECTION_CODES, String(error)).toContain(code);
    expect(await fs.readdir(destination), String(error)).toEqual([]);
    return { accepted: false, code: code as string };
  }
}

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

const tarEncoding = fc.constantFrom<TarSizeEncoding>(
  "octal",
  "octal-max",
  "base256",
  "base256-u64-max",
  "base256-high-bits",
  "base256-negative",
  "invalid-octal",
);

describe("structured TAR fuzz properties", () => {
  it("classifies malformed headers and hostile names without a third outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        adversarialPath,
        tarEncoding,
        fc.integer({ min: 0, max: 32 }),
        fc.integer({ min: 0, max: 34 }),
        fc.option(fc.integer({ min: 0, max: 511 }), { nil: undefined }),
        async (name, sizeEncoding, bodyLength, declaredSize, truncateTo) => {
          const bytes = tarBytes({
            name,
            body: Buffer.alloc(bodyLength, 0x61),
            declaredSize,
            sizeEncoding,
            truncateTo,
          });
          const javascript = await extractOutcome({
            bytes,
            kind: "tar",
            backend: "javascript",
          });
          expect(javascript).toEqual(expect.objectContaining({ accepted: expect.any(Boolean) }));
        },
      ),
      propertyParameters(80),
    );
  }, 15_000);

  it.runIf(Boolean(native))("keeps native and JavaScript TAR decisions equivalent", async () => {
    await fc.assert(
      fc.asyncProperty(
        adversarialPath,
        tarEncoding,
        fc.integer({ min: 0, max: 32 }),
        fc.integer({ min: 0, max: 34 }),
        async (name, sizeEncoding, bodyLength, declaredSize) => {
          const bytes = tarBytes({
            name,
            body: Buffer.alloc(bodyLength, 0x61),
            declaredSize,
            sizeEncoding,
          });
          const javascript = await extractOutcome({
            bytes,
            kind: "tar",
            backend: "javascript",
          });
          const nativeResult = await extractOutcome({
            bytes,
            kind: "tar",
            backend: "native",
          });
          expect(nativeResult.accepted, JSON.stringify({ name, sizeEncoding, bodyLength, declaredSize }))
            .toBe(javascript.accepted);
        },
      ),
      propertyParameters(60),
    );
  }, 15_000);
});

describe("structured ZIP fuzz properties", () => {
  it.runIf(Boolean(native))("keeps native and JavaScript ZIP decisions equivalent", async () => {
    await fc.assert(
      fc.asyncProperty(
        adversarialPath,
        fc.integer({ min: 0, max: 24 }),
        fc.option(fc.integer({ min: 1, max: 16 }), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
        async (name, bodyLength, truncateBy, declaredSizeDelta) => {
          const bytes = await zipBytes({
            names: [name],
            body: Buffer.alloc(bodyLength, 0x62),
            truncateBy,
            declaredSizeDelta,
          });
          const javascript = await extractOutcome({
            bytes,
            kind: "zip",
            backend: "javascript",
          });
          const nativeResult = await extractOutcome({
            bytes,
            kind: "zip",
            backend: "native",
          });
          expect(nativeResult.accepted, JSON.stringify({ name, bodyLength, truncateBy, declaredSizeDelta }))
            .toBe(javascript.accepted);
        },
      ),
      propertyParameters(50),
    );
  });
});

describe.each(["tar", "zip"] as const)("%s Windows-name portability", (kind) => {
  it.each(backends)(
    "pins reserved devices, ADS, and trailing aliases with %s",
    async (backend) => {
      const observed: Array<{ name: string; outcome: ArchiveOutcome }> = [];
      for (const name of WINDOWS_ARCHIVE_PORTABILITY_NAMES) {
        const bytes = kind === "tar"
          ? tarBytes({ name, body: Buffer.from("x") })
          : await zipBytes({ names: [name], body: Buffer.from("x") });
        const outcome = await extractOutcome({
          bytes,
          kind,
          backend,
        });
        observed.push({ name, outcome });
        if (process.platform === "win32") {
          expect(outcome, JSON.stringify({ kind, backend, name })).toEqual({
            accepted: false,
            code: name.includes(":") ? "entry-path" : "device-path",
          });
        } else {
          expect(outcome, JSON.stringify({ kind, backend, name })).toEqual({ accepted: true });
        }
      }
      if (
        process.platform === "win32" ||
        process.env.FS_SAFE_PRINT_ARCHIVE_PORTABILITY === "1"
      ) {
        console.info(JSON.stringify({ platform: process.platform, kind, backend, observed }));
      }
    },
    30_000,
  );
});

describe("minimized parser fuzz regressions", () => {
  it.each(backends)("rejects full-width base-256 overflow with %s", async (backend) => {
    await expect(extractOutcome({
      bytes: tarBytes({ name: "value", sizeEncoding: "base256-high-bits" }),
      kind: "tar",
      backend,
    })).resolves.toEqual({ accepted: false, code: "archive-header-invalid" });
  });

  it.each(backends)("types numeric TAR fields at and past their maxima with %s", async (backend) => {
    for (const sizeEncoding of [
      "octal-max",
      "invalid-octal",
      "base256-u64-max",
      "base256-high-bits",
    ] as const) {
      await expect(extractOutcome({
        bytes: tarBytes({ name: "value", sizeEncoding }),
        kind: "tar",
        backend,
      })).resolves.toEqual({ accepted: false, code: "archive-header-invalid" });
    }
  });

  it.each(backends)("types empty and separator-terminated TAR file names with %s", async (backend) => {
    for (const name of ["", "value/"]) {
      await expect(extractOutcome({
        bytes: tarBytes({ name, body: Buffer.from("x") }),
        kind: "tar",
        backend,
      })).resolves.toEqual({ accepted: false, code: "archive-header-invalid" });
    }
  });

  it.each(backends)("extracts a normalized backslash TAR name with %s", async (backend) => {
    await expect(extractOutcome({
      bytes: tarBytes({ name: "nested\\value", body: Buffer.from("x") }),
      kind: "tar",
      backend,
    })).resolves.toEqual({ accepted: true });
  });

  it.each(backends)("extracts one-code-unit names with %s", async (backend) => {
    for (const name of ["a", "é"]) {
      await expect(extractOutcome({
        bytes: tarBytes({ name, body: Buffer.from("x") }),
        kind: "tar",
        backend,
      })).resolves.toEqual({ accepted: true });
      await expect(extractOutcome({
        bytes: await zipBytes({ names: [name], body: Buffer.from("x") }),
        kind: "zip",
        backend,
      })).resolves.toEqual({ accepted: true });
    }
  });

  it.each(backends)("accepts a valid empty ZIP file with %s", async (backend) => {
    await expect(extractOutcome({
      bytes: await zipBytes({ names: ["empty"], body: Buffer.alloc(0) }),
      kind: "zip",
      backend,
      limits: { maxEntryBytes: 0, maxExtractedBytes: 0 },
    })).resolves.toEqual({ accepted: true });
  });

  it("types JSZip stream size mismatches for extraction and bounded reads", async () => {
    const bytes = await zipBytes({
      names: ["payload"],
      body: Buffer.alloc(0),
      declaredSizeDelta: 1,
    });
    await expect(extractOutcome({ bytes, kind: "zip", backend: "javascript" }))
      .resolves.toEqual({ accepted: false, code: "archive-header-invalid" });

    configureFsSafeNative({ mode: "off" });
    const base = await tempRoot("fs-safe-zip-size-mismatch-");
    const archivePath = path.join(base, "payload.zip");
    await fs.writeFile(archivePath, bytes);
    await expect(readArchiveEntry(archivePath, "payload", { maxBytes: 1, kind: "zip" }))
      .rejects.toMatchObject({ code: "archive-header-invalid" });
  });

  it.each(backends)("types truncated and overlong ZIP inputs with %s", async (backend) => {
    await expect(extractOutcome({
      bytes: await zipBytes({ names: ["value"], truncateBy: 1 }),
      kind: "zip",
      backend,
    })).resolves.toEqual({ accepted: false, code: "archive-header-invalid" });
    await expect(extractOutcome({
      bytes: await zipBytes({ names: [`long/${"x".repeat(256)}`] }),
      kind: "zip",
      backend,
    })).resolves.toEqual({ accepted: false, code: "entry-path" });
  });
});

describe.each(["tar", "zip"] as const)("%s collision properties", (kind) => {
  it.each(backends)(
    "rejects distinct spellings of one output with %s",
    async (backend) => {
      await fc.assert(
        fc.asyncProperty(archiveAliasingPathPair, async ([first, second]) => {
          const bytes = kind === "tar"
            ? tarEntriesBytes([{ name: first }, { name: second }])
            : await zipBytes({ names: [first, second] });
          await expect(extractOutcome({ bytes, kind, backend })).resolves.toMatchObject({
            accepted: false,
            code: "entry-path",
          });
        }),
        propertyParameters(20),
      );
    },
    10_000,
  );
});

describe.each(["tar", "zip"] as const)("%s declared limits", (kind) => {
  it.each(backends)(
    "honours maxEntryBytes exactly at and one past the boundary with %s",
    async (backend) => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 64 }), async (size) => {
          const body = Buffer.alloc(size, 0x63);
          const sizeEncoding = size % 2 === 0 ? "octal" : "base256";
          const bytes = kind === "tar"
            ? tarBytes({ name: "payload", body, sizeEncoding })
            : await zipBytes({ names: ["payload"], body });
          await expect(extractOutcome({
            bytes,
            kind,
            backend,
            limits: { maxEntryBytes: size, maxExtractedBytes: size },
          })).resolves.toEqual({ accepted: true });
          if (size > 0) {
            await expect(extractOutcome({
              bytes,
              kind,
              backend,
              limits: { maxEntryBytes: size - 1, maxExtractedBytes: size },
            })).resolves.toMatchObject({
              accepted: false,
              code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
            });
          }
        }),
        propertyParameters(20),
      );
    },
    20_000,
  );

  it.each(backends)(
    "honours entry-count, total-byte, path-component, and archive-byte edges with %s",
    async (backend) => {
      const body = Buffer.from("x");
      const archive = kind === "tar"
        ? tarEntriesBytes([{ name: "a/one", body }, { name: "a/two", body }])
        : await zipBytes({ names: ["a/one", "a/two"], body });
      const entryCount = kind === "zip" ? 3 : 2;
      await expect(extractOutcome({
        bytes: archive,
        kind,
        backend,
        limits: {
          maxArchiveBytes: archive.byteLength,
          maxEntries: entryCount,
          maxEntryBytes: 1,
          maxExtractedBytes: 2,
          maxEntryPathComponents: 2,
        },
      })).resolves.toEqual({ accepted: true });

      for (const [limits, code] of [
        [{ maxEntries: entryCount - 1 }, ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT],
        [{ maxExtractedBytes: 1 }, ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT],
        [{ maxEntryPathComponents: 1 }, ARCHIVE_LIMIT_ERROR_CODE.ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT],
        [{ maxArchiveBytes: archive.byteLength - 1 }, ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT],
      ] as const) {
        await expect(extractOutcome({ bytes: archive, kind, backend, limits }))
          .resolves.toMatchObject({ accepted: false, code });
      }
    },
    15_000,
  );
});
