import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRegularFile, appendRegularFileSync, type AppendRegularFileOptions } from "../src/regular-file.js";
import { root } from "../src/index.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => __setFsSafeTestHooksForTest());

async function fixture() {
  const directory = await tempRoot("fs-safe-append-snapshot-");
  const filePath = path.join(directory, "file");
  await fs.writeFile(filePath, "");
  return { directory, filePath };
}

describe.each([false, true])("append option snapshot, sync=%s", sync => {
  const append = (options: AppendRegularFileOptions) => sync ? appendRegularFileSync(options) : appendRegularFile(options);
  const beforeOpen = (callback: () => void) => __setFsSafeTestHooksForTest(sync
    ? { beforeRegularFileAppendOpenSync: callback }
    : { beforeRegularFileAppendOpen: callback });

  it("measures and writes one captured content and encoding", async () => {
    const { filePath } = await fixture();
    const options: AppendRegularFileOptions = { filePath, content: "é", encoding: "latin1", maxFileBytes: 1 };
    beforeOpen(() => { options.content = "too long"; options.encoding = "utf8"; });
    await append(options);
    expect(await fs.readFile(filePath)).toEqual(Buffer.from([0xe9]));
  });

  it("retains the cap when a real concurrent append grows the file", async () => {
    const { filePath } = await fixture();
    const options: AppendRegularFileOptions = { filePath, content: "a", maxFileBytes: 1 };
    beforeOpen(() => { fsSync.writeFileSync(filePath, "external"); options.maxFileBytes = Infinity; });
    await append(options);
    expect(await fs.readFile(filePath, "utf8")).toBe("external");
  });

  it("samples caller getters once with their original receiver", async () => {
    const { filePath } = await fixture();
    const reads = { content: 0, mode: 0, maxFileBytes: 0, encoding: 0 };
    const options: AppendRegularFileOptions = {
      filePath,
      get content() { expect(this).toBe(options); return ++reads.content === 1 ? "a" : "longer"; },
      get encoding() { expect(this).toBe(options); reads.encoding++; return "utf8"; },
      get mode() { expect(this).toBe(options); return ++reads.mode === 1 ? 0o600 : 0o666; },
      get maxFileBytes() { expect(this).toBe(options); reads.maxFileBytes++; return 100; },
    };
    await append(options);
    expect(reads).toEqual({ content: 1, mode: 1, maxFileBytes: 1, encoding: 1 });
    expect(await fs.readFile(filePath, "utf8")).toBe("a");
    if (process.platform !== "win32") expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });
});

it("captures asynchronous append inputs before returning its promise", async () => {
  const { filePath } = await fixture();
  const options: AppendRegularFileOptions = { filePath, content: "original", maxFileBytes: 8 };
  const pending = appendRegularFile(options);
  options.content = "replacement"; options.maxFileBytes = Infinity;
  await pending;
  expect(await fs.readFile(filePath, "utf8")).toBe("original");
});

describe.each(["utf8", "utf16le"] as const)("empty Root append with %s", encoding => {
  it.each([false, true])("preserves bytes and still creates missing files, durable=%s", async durable => {
    const { directory, filePath } = await fixture();
    const before = Buffer.from("original", encoding);
    await fs.writeFile(filePath, before);
    const scoped = await root(directory, { durable });
    for (const data of ["", Buffer.alloc(0)]) {
      await scoped.append("file", data, { encoding, prependNewlineIfNeeded: true });
      expect(await fs.readFile(filePath)).toEqual(before);
    }
    await scoped.append("new", "", { encoding, prependNewlineIfNeeded: true });
    expect((await fs.stat(path.join(directory, "new"))).size).toBe(0);
  });
});
