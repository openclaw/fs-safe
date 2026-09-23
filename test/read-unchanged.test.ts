import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fileStore } from "../src/file-store.js";
import { readLocalFileFromRoots } from "../src/local-roots.js";
import { readLocalFileSafely, root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-unchanged-read-");
  const filePath = path.join(directory, "value");
  await fs.writeFile(filePath, '{"ok":1}');
  return { directory, filePath, scoped: await root(directory) };
}

function afterRead(filePath: string, mutate: () => Promise<void>) {
  let opened: FileHandle | undefined;
  __setFsSafeTestHooksForTest({
    afterOpen(candidate, handle) {
      if (candidate !== filePath) return;
      opened = handle;
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
        const result = await read(...args);
        await mutate();
        return result;
      });
      const readFile = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementationOnce(async (...args) => {
        const result = await readFile(...args);
        await mutate();
        return result;
      });
    },
  });
  return () => opened;
}

it.each(["append", "truncate", "rewrite", "hardlink"] as const)(
  "rejects a real %s during a bounded read and closes the descriptor",
  async mutation => {
    const { filePath, scoped } = await fixture();
    const opened = afterRead(filePath, async () => {
      if (mutation === "append") await fs.appendFile(filePath, " ");
      else if (mutation === "truncate") await fs.truncate(filePath, 0);
      else if (mutation === "hardlink") await fs.link(filePath, `${filePath}.alias`);
      else {
        await fs.writeFile(filePath, '{"ok":2}');
        await fs.utimes(filePath, new Date(0), new Date(0));
      }
    });
    await expect(scoped.read("value", { maxBytes: 32, verifyUnchanged: true }))
      .rejects.toMatchObject({ code: "read-changed", category: "operational" });
    expect(opened()?.fd).toBe(-1);
  },
);

it.each([undefined, false])("preserves ordinary reads when verifyUnchanged=%s", async verifyUnchanged => {
  const { filePath, scoped } = await fixture();
  afterRead(filePath, () => fs.appendFile(filePath, " "));
  const result = await scoped.read("value", { maxBytes: 32, verifyUnchanged });
  expect(result.buffer.toString()).toBe('{"ok":1} ');
  expect(result.stat.size).toBe(8);
});

it.each([
  "readBytes", "readText", "readJson", "readAbsolute", "reader", "local", "local-unbounded",
  "root-unbounded", "store-read", "store-readBytes", "store-readText", "store-readTextIfExists",
  "store-readJson", "store-readJsonIfExists", "local-roots",
] as const)("forwards verification through %s", async method => {
  const { directory, filePath, scoped } = await fixture();
  const options = { maxBytes: 32, verifyUnchanged: true };
  afterRead(filePath, () => fs.appendFile(filePath, " "));
  const store = fileStore({ rootDir: directory });
  let operation: Promise<unknown>;
  switch (method) {
    case "readBytes": operation = scoped.readBytes("value", options); break;
    case "readText": operation = scoped.readText("value", options); break;
    case "readJson": operation = scoped.readJson("value", options); break;
    case "readAbsolute": operation = scoped.readAbsolute(filePath, options); break;
    case "reader": operation = scoped.reader(options)(filePath); break;
    case "local": operation = readLocalFileSafely({ filePath, ...options }); break;
    case "local-unbounded": operation = readLocalFileSafely({ filePath, verifyUnchanged: true }); break;
    case "root-unbounded": operation = scoped.read("value", { ...options, maxBytes: Infinity }); break;
    case "store-read": operation = store.read("value", options); break;
    case "store-readBytes": operation = store.readBytes("value", options); break;
    case "store-readText": operation = store.readText("value", options); break;
    case "store-readTextIfExists": operation = store.readTextIfExists("value", options); break;
    case "store-readJson": operation = store.readJson("value", options); break;
    case "store-readJsonIfExists": operation = store.readJsonIfExists("value", options); break;
    case "local-roots":
      operation = readLocalFileFromRoots({ filePath, roots: [directory], ...options }); break;
  }
  if (method === "local-roots") await expect(operation).resolves.toBeNull();
  else await expect(operation).rejects.toMatchObject({ code: "read-changed" });
});

it("returns the final stat while allowing read-induced access-time changes", async () => {
  const { filePath, scoped } = await fixture();
  __setFsSafeTestHooksForTest({
    afterOpen(candidate, handle) {
      if (candidate !== filePath) return;
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async options => {
        const result = await stat(options);
        if (!options?.bigint) result.atimeMs = 123;
        return result;
      });
    },
  });
  const result = await scoped.read("value", { verifyUnchanged: true });
  expect(result.buffer.toString()).toBe('{"ok":1}');
  expect(result.stat.atimeMs).toBe(123);
  expect(result.stat.size).toBe(8);
});

it("rejects nonempty bytes when unchanged descriptor metadata reports zero size", async () => {
  const { filePath, scoped } = await fixture();
  __setFsSafeTestHooksForTest({
    afterOpen(candidate, handle) {
      if (candidate !== filePath) return;
      // Virtual files can report zero size; preserve real bigint path admission.
      const fstat = fsSync.fstatSync.bind(fsSync);
      vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
        const result = fstat(fd, options);
        if (fd === handle.fd && !options?.bigint) result.size = 0;
        return result;
      });
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async options => {
        const result = await stat(options);
        if (!options?.bigint) result.size = 0;
        return result;
      });
    },
  });
  await expect(scoped.read("value", { verifyUnchanged: true }))
    .rejects.toMatchObject({ code: "read-changed" });
  expect(await fs.readFile(filePath, "utf8")).toBe('{"ok":1}');
});

it("keeps the byte limit authoritative for verified reads", async () => {
  const { filePath, scoped } = await fixture();
  afterRead(filePath, () => fs.appendFile(filePath, " "));
  await expect(scoped.read("value", { maxBytes: 8, verifyUnchanged: true }))
    .rejects.toMatchObject({ code: "too-large" });
});

it("captures the standalone verification option before asynchronous opening", async () => {
  const { filePath } = await fixture();
  const options = { filePath, maxBytes: 32, verifyUnchanged: true };
  afterRead(filePath, () => fs.appendFile(filePath, " "));
  const result = readLocalFileSafely(options);
  options.verifyUnchanged = false;
  await expect(result).rejects.toMatchObject({ code: "read-changed" });
});
