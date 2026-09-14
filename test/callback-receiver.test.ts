import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDurableDirectory } from "../src/directory-durability.js";
import { copyFileHandle, transferFileHandle, type CopyFileHandleOptions } from "../src/file-handle-transfer.js";
import { loadJsonDurableQueueEntry, resolveJsonDurableQueueEntryPaths } from "../src/json-durable-queue.js";
import { readRootStructuredFileSync, type ReadRootStructuredFileSyncOptions } from "../src/json.js";
import { writeCallbackSibling } from "../src/sibling-staged-file.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("snapshotted callback receivers", () => {
  it.each([false, true])("preserves structured parser receivers with inherited callbacks: %s", async inherited => {
    const rootDir = await tempRoot("fs-safe-parser-receiver-");
    await fs.writeFile(path.join(rootDir, "config.json"), '{"ok":true}');
    let relativePath = "config.json";
    const reads = { parse: 0, validate: 0, relativePath: 0 };
    let parseThis: unknown, validateThis: unknown, invalidThis: unknown;
    const callbacks = Object.defineProperties({}, {
      parse: { get() {
        reads.parse++;
        return function (this: unknown, raw: string) {
          parseThis = this;
          relativePath = "unused.json";
          return JSON.parse(raw);
        };
      } },
      validate: { get() {
        reads.validate++;
        return function (this: unknown, value: unknown): value is { ok: true } {
          validateThis = this;
          expect(value).toEqual({ ok: true });
          return false;
        };
      } },
    });
    const options = Object.assign(inherited ? Object.create(callbacks) : callbacks, {
      rootDir, boundaryLabel: "receiver test",
      invalidMessage: function (this: unknown, name: string) {
        invalidThis = this;
        return `invalid ${name}`;
      },
    }) as ReadRootStructuredFileSyncOptions<{ ok: true }>;
    Object.defineProperty(options, "relativePath", { get() { reads.relativePath++; return relativePath; } });
    expect(readRootStructuredFileSync(options)).toEqual({ ok: false, reason: "invalid", error: "invalid config.json" });
    expect(parseThis).toBe(options);
    expect(validateThis).toBe(options);
    expect(invalidThis).toBeUndefined();
    expect(reads).toEqual({ parse: 1, validate: 1, relativePath: 1 });
  });

  it("reads the needed directory creator once and invokes it on the caller's options", async () => {
    const rootDir = await tempRoot("fs-safe-create-receiver-");
    const directoryPath = path.join(rootDir, "created");
    let requestedPath = directoryPath;
    let reads = 0, pathReads = 0;
    const replacement = vi.fn(async () => {});
    let creator = async function (this: unknown, pathname: string) {
      expect(this).toBe(options);
      expect(pathname).toBe(directoryPath);
      await fs.mkdir(pathname);
    };
    const options = Object.create(Object.defineProperty({}, "create", {
      get() { reads++; const selected = creator; creator = replacement; return selected; },
    })) as Parameters<typeof ensureDurableDirectory>[0];
    Object.defineProperty(options, "directoryPath", {
      get() { pathReads++; return requestedPath; },
    });
    const pending = ensureDurableDirectory(options);
    expect(reads).toBe(0);
    requestedPath = path.join(rootDir, "unused");
    await expect(pending).resolves.toMatchObject({ path: directoryPath });
    expect(replacement).not.toHaveBeenCalled();
    expect(reads).toBe(1);
    expect(pathReads).toBe(1);
    await expect(fs.lstat(requestedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not evaluate an unused creator for an existing directory", async () => {
    const directoryPath = await tempRoot("fs-safe-unused-creator-");
    const options = {
      directoryPath,
      get create(): never { throw new Error("unused creator getter"); },
    };
    await expect(ensureDurableDirectory(options)).resolves.toMatchObject({ path: directoryPath });
  });

  it("reads a claimed queue reader once and retains its params receiver and admitted paths", async () => {
    const rootDir = await tempRoot("fs-safe-queue-receiver-");
    const paths = resolveJsonDurableQueueEntryPaths(rootDir, "entry");
    const jsonPath = paths.jsonPath;
    await fs.writeFile(jsonPath, '{"ok":true}');
    let reads = 0;
    const replacement = vi.fn(async (entry: { ok: boolean }) => ({ entry }));
    let reader = async function (this: unknown, entry: { ok: boolean }, pathname: string) {
      expect(this).toBe(params);
      expect(pathname).toBe(jsonPath);
      return { entry };
    };
    const params = Object.assign(Object.create(Object.defineProperty({}, "read", {
      get() { reads++; const selected = reader; reader = replacement; return selected; },
    })), { paths, tempPrefix: "receiver" });
    const pending = loadJsonDurableQueueEntry<{ ok: boolean }>(params);
    expect(reads).toBe(0);
    paths.jsonPath = path.join(rootDir, "unused.json");
    await expect(pending).resolves.toEqual({ ok: true });
    expect(reads).toBe(1);
    expect(replacement).not.toHaveBeenCalled();
    await expect(fs.lstat(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not evaluate an unused reader when the queue entry is missing", async () => {
    const rootDir = await tempRoot("fs-safe-unused-queue-reader-");
    const params = {
      paths: resolveJsonDurableQueueEntryPaths(rootDir, "missing"), tempPrefix: "receiver",
      get read(): never { throw new Error("unused reader getter"); },
    };
    await expect(loadJsonDurableQueueEntry(params)).resolves.toBeNull();
  });

  it.each([undefined, "private-directory"] as const)(
    "retains both sibling callback receivers while snapshots survive mutations during the writer: %s",
    async (producerIsolation) => {
      const rootDir = await tempRoot("fs-safe-sibling-receiver-");
      const tempPath = path.join(rootDir, "stage.tmp");
      const finalPath = path.join(rootDir, "final");
      let requestedTemp = tempPath;
      let requestedIsolation = producerIsolation;
      const reads = { write: 0, producerIsolation: 0, resolveFinalPath: 0, tempPath: 0 };
      const replacement = vi.fn(() => path.join(rootDir, "unused"));
      let resolver = function (this: unknown, value: string) {
        expect(this).toBe(params);
        expect(value).toBe("written");
        return finalPath;
      };
      let writer = async function (this: unknown, pathname: string) {
        expect(this).toBe(params);
        if (producerIsolation === undefined) expect(pathname).toBe(tempPath);
        else expect(path.dirname(pathname)).not.toBe(rootDir);
        resolver = replacement;
        requestedTemp = path.join(rootDir, "unused.tmp");
        await fs.writeFile(pathname, "content");
        return "written";
      };
      const params = Object.assign(Object.create(Object.defineProperties({}, {
        write: { get() { reads.write++; return writer; } },
        producerIsolation: { get() { reads.producerIsolation++; return requestedIsolation; } },
        resolveFinalPath: { get() { reads.resolveFinalPath++; return resolver; } },
        tempPath: { get() { reads.tempPath++; return requestedTemp; } },
      })), { syncTempFile: false, syncParentDir: false });
      const pending = writeCallbackSibling(params);
      const replacementWriter = vi.fn(async () => "replacement");
      writer = replacementWriter;
      requestedIsolation = producerIsolation === undefined ? "private-directory" : undefined;
      await expect(pending).resolves.toEqual({ filePath: finalPath, result: "written" });
      expect(reads).toEqual({ write: 1, producerIsolation: 1, resolveFinalPath: 1, tempPath: 1 });
      expect(replacementWriter).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      expect(await fs.readFile(finalPath, "utf8")).toBe("content");
    },
  );

  it.each([undefined, "private-directory"] as const)(
    "preserves the public sibling wrapper's shared internal receiver: %s",
    async (producerIsolation) => {
      const dir = await tempRoot("fs-safe-sibling-wrapper-receiver-");
      let receiver: unknown;
      const options = {
        dir,
        writeTemp: async function (this: unknown, pathname: string) {
          receiver = this;
          expect(this).toHaveProperty("tempPath");
          if (producerIsolation === undefined) expect(this).toMatchObject({ tempPath: pathname });
          else expect(pathname).not.toBe((this as { tempPath: string }).tempPath);
          await fs.writeFile(pathname, "content");
          return "final";
        },
        resolveFinalPath: function (this: unknown, name: string) {
          expect(this).toBe(receiver);
          expect(this).not.toBe(options);
          return path.join(dir, name);
        },
        producerIsolation,
      };
      await expect(writeSiblingTempFile(options)).resolves.toMatchObject({ result: "final" });
    },
  );

  it("preserves the direct transfer authority receiver while freezing the selected assertion", async () => {
    const rootDir = await tempRoot("fs-safe-transfer-receiver-");
    const sourcePath = path.join(rootDir, "source"), targetPath = path.join(rootDir, "target");
    await fs.writeFile(sourcePath, "content");
    const source = await fs.open(sourcePath, "r"), target = await fs.open(targetPath, "w+");
    let reads = 0;
    const replacement = vi.fn();
    let assertion = function (this: unknown) { expect(this).toBe(options); };
    const options = Object.assign(Object.create(Object.defineProperty({}, "assertBeforeMutation", {
      get() { reads++; return assertion; },
    })), {
      sizeHint: 7,
      onChunk: function (this: unknown) {
        expect(this).toBe(options);
        assertion = replacement;
      },
    });
    try {
      await expect(transferFileHandle(source, target, options)).resolves.toBe(7);
      expect(reads).toBe(1);
      expect(replacement).not.toHaveBeenCalled();
      expect(await fs.readFile(targetPath, "utf8")).toBe("content");
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
  });

  it("preserves late copy observer state without rereading captured option accessors", async () => {
    const rootDir = await tempRoot("fs-safe-copy-receiver-");
    const sourcePath = path.join(rootDir, "source"), targetPath = path.join(rootDir, "target");
    await fs.writeFile(sourcePath, "content");
    const source = await fs.open(sourcePath, "r"), target = await fs.open(targetPath, "w+");
    const marker = Symbol("receiver marker");
    const markerValue = {};
    let state = "original";
    const reads = { signal: 0, maxBytes: 0, onChunk: 0, assertBeforeMutation: 0, state: 0 };
    const authority = function (this: unknown) { expect(this).toBeUndefined(); };
    const observer = function (this: Record<PropertyKey, unknown>) {
      expect(this === options).toBe(false);
      expect(Object.getPrototypeOf(this)).toBe(Object.prototype);
      expect(this.state).toBe("replacement");
      expect(this[marker]).toBe(markerValue);
      expect(Object.getOwnPropertyDescriptor(this, "__proto__")?.value).toBe(markerValue);
      expect(this).toMatchObject({ sizeHint: 7, targetPosition: 0, maxBytes: 7 });
      expect(this.hidden).toBeUndefined();
      expect(this.inherited).toBeUndefined();
      this.assertBeforeMutation = () => { throw new Error("replacement authority"); };
    };
    const options = Object.defineProperties(Object.create({ inherited: true }), {
      [marker]: { value: markerValue, enumerable: true },
      ["__proto__"]: { value: markerValue, enumerable: true },
      hidden: { value: true },
      state: { enumerable: true, get() { reads.state++; return state; } },
      signal: { enumerable: true, get() { reads.signal++; return undefined; } },
      maxBytes: { enumerable: true, get() { reads.maxBytes++; return 7; } },
      onChunk: { enumerable: true, get() { reads.onChunk++; return observer; } },
      assertBeforeMutation: { enumerable: true, get() { reads.assertBeforeMutation++; return authority; } },
    }) as CopyFileHandleOptions;
    // A callback's own call property must never replace its selected behavior.
    Object.defineProperty(observer, "call", { get() { throw new Error("unexpected callback.call"); } });
    try {
      const pending = copyFileHandle(source, target, options);
      expect(reads).toEqual({ signal: 1, maxBytes: 1, onChunk: 1, assertBeforeMutation: 1, state: 0 });
      state = "replacement";
      await expect(pending).resolves.toBe(7);
      expect(reads).toEqual({ signal: 1, maxBytes: 1, onChunk: 1, assertBeforeMutation: 1, state: 1 });
      expect(fsSync.readFileSync(targetPath, "utf8")).toBe("content");
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
  });
});
