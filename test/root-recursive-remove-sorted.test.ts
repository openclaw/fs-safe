import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture(names: string[] = ["a", "b", "c"]) {
  const directory = await tempRoot("fs-safe-remove-sort-");
  const tree = path.join(directory, "tree");
  await fs.mkdir(tree);
  await Promise.all(names.map(name => fs.writeFile(path.join(tree, name), name)));
  return { directory, tree, scoped: await root(directory) };
}

const removalOrders: { label: string; order?: "filesystem" | "sorted"; maxEntries?: number }[] = [
  { label: "default" },
  { label: "filesystem", order: "filesystem" },
  { label: "sorted", order: "sorted" },
  { label: "unbounded sorted", order: "sorted", maxEntries: Infinity },
];

it.each(removalOrders)("removes in $label sibling order and keeps directory deletion postorder", async ({ order, maxEntries }) => {
  const { directory, tree, scoped } = await fixture(["z-file", "B-file"]);
  await fs.mkdir(path.join(tree, "a-dir"));
  await fs.mkdir(path.join(tree, "m-dir"));
  await fs.writeFile(path.join(tree, "a-dir/A-leaf"), "A");
  await fs.writeFile(path.join(tree, "a-dir/z-leaf"), "z");
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const entries: Dirent[] = [];
    for (;;) {
      const entry = await handle.read();
      if (!entry) break;
      entries.push(entry);
    }
    // Replay real directory entries in a known order, independent of the host filesystem.
    entries.sort((left, right) => left.name < right.name ? 1 : left.name > right.name ? -1 : 0);
    vi.spyOn(handle, "read").mockImplementation(async () => entries.shift() ?? null);
    return handle;
  });
  const readdir = fs.readdir.bind(fs);
  vi.spyOn(fs, "readdir").mockImplementation(async (...args) => (await readdir(...args)).sort().reverse());
  const removed: string[] = [];
  for (const method of ["unlink", "rmdir"] as const) {
    const remove = fs[method].bind(fs);
    vi.spyOn(fs, method).mockImplementation(async target => {
      await remove(target);
      removed.push(path.relative(directory, String(target)).split(path.sep).join("/"));
    });
  }
  await scoped.remove("tree", { recursive: true, order, maxEntries });
  expect(removed).toEqual(order === "sorted"
    ? ["tree/B-file", "tree/a-dir/A-leaf", "tree/a-dir/z-leaf", "tree/a-dir", "tree/m-dir", "tree/z-file", "tree"]
    : ["tree/z-file", "tree/m-dir", "tree/a-dir/z-leaf", "tree/a-dir/A-leaf", "tree/a-dir", "tree/B-file", "tree"]);
  expect(await fs.readdir(directory)).toEqual([]);
});

it.each(["failure", "abort"] as const)("closes the retained directory handle after an unbounded name-read %s", async outcome => {
  const { tree, scoped } = await fixture();
  const controller = new AbortController();
  const reason = Object.assign(new Error("bulk name read stopped"), { code: "EACCES" });
  let closed = 0;
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed += 1; });
    return handle;
  });
  const readdir = fs.readdir.bind(fs);
  vi.spyOn(fs, "readdir").mockImplementationOnce(async (...args) => {
    const names = await readdir(...args);
    if (outcome === "failure") throw reason;
    controller.abort(reason);
    return names;
  });

  const pending = scoped.remove("tree", { recursive: true, order: "sorted", maxEntries: Infinity, signal: controller.signal });
  if (outcome === "abort") await expect(pending).rejects.toBe(reason);
  else await expect(pending).rejects.toMatchObject({
    code: "not-removable", cause: reason,
    details: { operation: "remove", phase: "enumerate", relativePath: "" },
  });
  expect(closed).toBe(1);
  expect((await fs.readdir(tree)).sort()).toEqual(["a", "b", "c"]);
});

it("accepts explicit Infinity while a finite depth budget still limits removal", async () => {
  const { directory, tree, scoped } = await fixture([]);
  const deepest = path.join(tree, "d", "d");
  await fs.mkdir(deepest, { recursive: true });
  await fs.writeFile(path.join(deepest, "value"), "preserve");
  await expect(scoped.remove("tree", { recursive: true, order: "sorted", maxEntries: Infinity, maxDepth: 1 }))
    .rejects.toMatchObject({ code: "too-large" });
  expect(await fs.readFile(path.join(deepest, "value"), "utf8")).toBe("preserve");
  await scoped.remove("tree", { recursive: true, order: "sorted", maxEntries: Infinity, maxDepth: Infinity });
  expect(await fs.readdir(directory)).toEqual([]);
});

it.each([1, 3])("bounds sorted name collection before child metadata or deletion with maxEntries=%i", async maxEntries => {
  const { tree, scoped } = await fixture();
  const observed = new Set<string>();
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (path.dirname(String(args[0])) === tree) observed.add(String(args[0]));
    return lstat(...args);
  });
  let reads = 0;
  let closed = 0;
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async () => { reads += 1; return await read(); });
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed += 1; });
    return handle;
  });
  const unlink = vi.spyOn(fs, "unlink");
  const rmdir = vi.spyOn(fs, "rmdir");
  await expect(scoped.remove("tree", { recursive: true, order: "sorted", maxEntries }))
    .rejects.toMatchObject({ code: "too-large" });
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual(maxEntries);
  expect(observed.size).toBe(0);
  expect(unlink).not.toHaveBeenCalled();
  expect(rmdir).not.toHaveBeenCalled();
  expect(closed).toBe(1);
  expect((await fs.readdir(tree)).sort()).toEqual(["a", "b", "c"]);
});

it("shares the sorted entry budget with pending sibling names before descending", async () => {
  const { directory, tree, scoped } = await fixture(["b-file"]);
  await fs.mkdir(path.join(tree, "a-dir"));
  await fs.writeFile(path.join(tree, "a-dir/leaf"), "preserve");

  await expect(scoped.remove("tree", { recursive: true, order: "sorted", maxEntries: 3 }))
    .rejects.toMatchObject({ code: "too-large" });

  expect(await fs.readFile(path.join(tree, "a-dir/leaf"), "utf8")).toBe("preserve");
  expect((await fs.readdir(tree)).sort()).toEqual(["a-dir", "b-file"]);
  expect(await fs.readdir(directory)).toEqual(["tree"]);
});

it("settles an admitted name read and directory close before rejecting collection cancellation", async () => {
  const { tree, scoped } = await fixture();
  const controller = new AbortController();
  const details = Object.freeze({ operation: "caller-owned", phase: "cancel", relativePath: "preserve" });
  const reason = new FsSafeError("not-found", "canceled during sorted name collection", { details });
  const reading = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  let reads = 0;
  let readSettled = false;
  let closeStarted = false;
  let closed = 0;
  let settled = false;
  const observed = new Set<string>();
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (path.dirname(String(args[0])) === tree) observed.add(String(args[0]));
    return lstat(...args);
  });
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async () => {
      const entry = await read();
      reads += 1;
      if (reads === 2) {
        reading.resolve();
        await releaseRead.promise;
        readSettled = true;
      }
      return entry;
    });
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closeStarted = true;
      await close();
      closing.resolve();
      await releaseClose.promise;
      closed += 1;
    });
    return handle;
  });
  const unlink = vi.spyOn(fs, "unlink");
  const rmdir = vi.spyOn(fs, "rmdir");
  const pending = scoped.remove("tree", { recursive: true, order: "sorted", force: true, signal: controller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([
      reading.promise,
      pending.then(() => { throw new Error("removal finished before the second directory read"); }),
    ]);
    controller.abort(reason);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(closeStarted).toBe(false);
    expect(closed).toBe(0);
    expect(observed.size).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
    releaseRead.resolve();
    await Promise.race([
      closing.promise,
      pending.then(() => { throw new Error("removal finished before directory close"); }),
    ]);
    expect(readSettled).toBe(true);
    expect(settled).toBe(false);
    releaseClose.resolve();
    await expect(pending).rejects.toBe(reason);
    expect(reason.details).toBe(details);
    expect(closed).toBe(1);
    expect((await fs.readdir(tree)).sort()).toEqual(["a", "b", "c"]);
  } finally {
    releaseRead.resolve();
    releaseClose.resolve();
    await pending.catch(() => undefined);
  }
});
