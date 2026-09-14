import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileHandle } from "../src/advanced.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const handles: FileHandle[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map(handle => handle.close()));
});

async function fixture(content: string | Buffer = "source bytes", prior = "original target with a tail") {
  const directory = await tempRoot("fs-safe-handle-transfer-");
  const sourcePath = path.join(directory, "source");
  const targetPath = path.join(directory, "target");
  await fs.writeFile(sourcePath, content, { mode: 0o600 });
  await fs.writeFile(targetPath, prior, { mode: 0o640 });
  const source = await fs.open(sourcePath, "r");
  handles.push(source);
  const target = await fs.open(targetPath, "r+");
  handles.push(target);
  return { source, target, sourcePath, targetPath, content: Buffer.from(content), prior };
}

describe("borrowed FileHandle copying", () => {
  it("copies from zero, preserves both cursors and modes, and leaves target suffixes and handles owned by the caller", async () => {
    const f = await fixture();
    await f.source.read(Buffer.alloc(2), 0, 2, null);
    await f.target.read(Buffer.alloc(3), 0, 3, null);
    const initialMode = (await f.target.stat()).mode;
    expect(await copyFileHandle(f.source, f.target)).toBe(f.content.length);
    const expected = Buffer.concat([f.content, Buffer.from(f.prior).subarray(f.content.length)]);
    expect(await fs.readFile(f.targetPath)).toEqual(expected);
    expect((await f.target.stat()).mode).toBe(initialMode);
    const sourceNext = Buffer.alloc(1);
    const targetNext = Buffer.alloc(1);
    await f.source.read(sourceNext, 0, 1, null);
    await f.target.read(targetNext, 0, 1, null);
    expect(sourceNext).toEqual(f.content.subarray(2, 3));
    expect(targetNext).toEqual(f.content.subarray(3, 4));
  });

  it("completes positive short reads and writes without changing the source observer bytes", async () => {
    const f = await fixture(Buffer.alloc(317).map((_, index) => index % 251), "");
    const read = f.source.read.bind(f.source);
    const write = f.target.write.bind(f.target);
    vi.spyOn(f.source, "read").mockImplementation(async (buffer, offset, length, position) =>
      await read(buffer, offset, Math.min(length, 19), position));
    vi.spyOn(f.target, "write").mockImplementation(async (buffer, offset, length, position) =>
      await write(buffer, offset, Math.min(length, 7), position));
    const digest = createHash("sha256");
    const bytes = await copyFileHandle(f.source, f.target, { onChunk: chunk => { digest.update(chunk); } });
    expect(bytes).toBe(f.content.length);
    expect(await fs.readFile(f.targetPath)).toEqual(f.content);
    expect(digest.digest("hex")).toBe(createHash("sha256").update(f.content).digest("hex"));
  });

  it("batches large transfers through one bounded buffer", async () => {
    const content = Buffer.alloc(3 * 1024 * 1024 + 31, 7);
    content[1024 * 1024] = 11;
    content[2 * 1024 * 1024] = 13;
    content[content.length - 1] = 17;
    const f = await fixture(content, "");
    const read = vi.spyOn(f.source, "read");
    expect(await copyFileHandle(f.source, f.target)).toBe(content.length);
    expect((await fs.readFile(f.targetPath)).equals(content)).toBe(true);
    expect(read.mock.calls.length).toBeLessThan(10);
    const buffer = read.mock.calls[0]![0];
    expect(buffer.byteLength).toBeLessThanOrEqual(512 * 1024);
    for (const call of read.mock.calls) expect(call[0]).toBe(buffer);
  });

  it.each([0, 3, 65_536])("caps scratch allocation to the %i-byte budget plus its overflow probe", async (maxBytes) => {
    const f = await fixture(Buffer.alloc(maxBytes, 7), "");
    const read = vi.spyOn(f.source, "read");
    expect(await copyFileHandle(f.source, f.target, { maxBytes })).toBe(maxBytes);
    expect(read.mock.calls[0]![0].byteLength).toBeLessThanOrEqual(maxBytes + 1);
    expect((await fs.readFile(f.targetPath)).equals(f.content)).toBe(true);
  });

  it("observes source bytes before a pending target write and settles that write before cancellation", async () => {
    const f = await fixture("source", "");
    const controller = new AbortController();
    const aborted = new Error("synthetic cancellation");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = f.target.write.bind(f.target);
    const digest = createHash("sha256");
    let observed = 0;
    let settled = false;
    vi.spyOn(f.target, "write").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return await write(...args);
    });
    const pending = copyFileHandle(f.source, f.target, {
      signal: controller.signal,
      onChunk: chunk => { observed += chunk.byteLength; digest.update(chunk); },
    });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise;
      expect(observed).toBe(f.content.length);
      expect(digest.digest("hex")).toBe(createHash("sha256").update(f.content).digest("hex"));
      controller.abort(aborted);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
    await expect(pending).rejects.toBe(aborted);
    expect(await fs.readFile(f.targetPath)).toEqual(f.content);
    expect((await f.target.stat()).size).toBe(f.content.length);
  });

  it("waits for an admitted source read after cancellation and does not write its late result", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const aborted = new Error("synthetic cancellation");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = f.source.read.bind(f.source);
    let settled = false;
    vi.spyOn(f.source, "read").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return await read(...args);
    });
    const pending = copyFileHandle(f.source, f.target, { signal: controller.signal });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise;
      controller.abort(aborted);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
    await expect(pending).rejects.toBe(aborted);
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
  });

  it.each(["observer", "authority", "async-observer", "async-authority"] as const)(
    "refuses the current chunk after %s rejection without cleanup or target mutation", async kind => {
      const f = await fixture();
      const failure = new Error("synthetic callback refusal");
      const synchronous = () => { throw failure; };
      const asynchronous = async () => {};
      const callback = kind.startsWith("async") ? asynchronous : synchronous;
      const pending = copyFileHandle(f.source, f.target, kind.endsWith("observer")
        ? { onChunk: callback } : { assertBeforeMutation: callback });
      if (kind.startsWith("async")) await expect(pending).rejects.toBeInstanceOf(TypeError);
      else await expect(pending).rejects.toBe(failure);
      expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
      expect((await f.source.stat()).isFile()).toBe(true);
      expect((await f.target.stat()).isFile()).toBe(true);
    },
  );

  it("rechecks authority before a second partial write and preserves the admitted prefix", async () => {
    const f = await fixture("abcdef", "");
    const failure = new Error("synthetic expired owner");
    const write = f.target.write.bind(f.target);
    let authorized = true;
    vi.spyOn(f.target, "write").mockImplementation(async (buffer, offset, length, position) => {
      const result = await write(buffer, offset, Math.min(length, 2), position);
      authorized = false;
      return result;
    });
    await expect(copyFileHandle(f.source, f.target, {
      assertBeforeMutation: () => { if (!authorized) throw failure; },
    })).rejects.toBe(failure);
    expect(await fs.readFile(f.targetPath, "utf8")).toBe("ab");
  });

  it("rejects a zero-progress write while leaving both handles and target bytes intact", async () => {
    const f = await fixture();
    vi.spyOn(f.target, "write").mockImplementation(async buffer => ({ bytesWritten: 0, buffer }));
    await expect(copyFileHandle(f.source, f.target)).rejects.toMatchObject({ code: "helper-failed" });
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
    expect((await f.source.stat()).isFile()).toBe(true);
    expect((await f.target.stat()).isFile()).toBe(true);
  });

  it("enforces zero, exact, invalid, and initially exceeded byte budgets before target mutation", async () => {
    const f = await fixture("1234", "unchanged");
    for (const maxBytes of [-1, NaN, 1.5]) {
      await expect(copyFileHandle(f.source, f.target, { maxBytes })).rejects.toBeInstanceOf(RangeError);
    }
    for (const maxBytes of [0, 3]) {
      await expect(copyFileHandle(f.source, f.target, { maxBytes })).rejects.toMatchObject({ code: "too-large" });
    }
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
    expect(await copyFileHandle(f.source, f.target, { maxBytes: 4 })).toBe(4);
    const empty = await fixture("", "retained");
    expect(await copyFileHandle(empty.source, empty.target, { maxBytes: 0 })).toBe(0);
    expect(await fs.readFile(empty.targetPath, "utf8")).toBe("retained");
  });

  it("refuses source growth past the byte cap without writing the excess bytes", async () => {
    const f = await fixture(Buffer.alloc(256 * 1024, 7), "");
    let grew = false;
    await expect(copyFileHandle(f.source, f.target, {
      maxBytes: f.content.length,
      onChunk() {
        if (!grew) {
          grew = true;
          // Another writer adds data after admission; the next read probes beyond the cap.
          fsSync.appendFileSync(f.sourcePath, "excess");
        }
      },
    })).rejects.toMatchObject({ code: "too-large" });
    expect(await fs.readFile(f.targetPath)).toEqual(f.content);
    expect((await f.source.stat()).size).toBe(f.content.length + 6);
  });

  it("does not apply Root's default 16 MiB read cap", async () => {
    const f = await fixture("", "");
    const bytes = 17 * 1024 * 1024;
    await fs.truncate(f.sourcePath, bytes);
    expect(await copyFileHandle(f.source, f.target)).toBe(bytes);
    expect((await f.target.stat()).size).toBe(bytes);
  });

  it("rejects an already aborted signal before inspecting the borrowed handles", async () => {
    const f = await fixture();
    const aborted = new Error("synthetic pre-abort");
    const inspect = vi.spyOn(f.source, "stat");
    await expect(copyFileHandle(f.source, f.target, { signal: AbortSignal.abort(aborted) })).rejects.toBe(aborted);
    expect(inspect).not.toHaveBeenCalled();
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
  });

  it.skipIf(process.platform === "win32")("refuses a directory handle without changing its target", async () => {
    const f = await fixture();
    const directory = await fs.open(path.dirname(f.sourcePath), "r");
    handles.push(directory);
    await expect(copyFileHandle(directory, f.target)).rejects.toMatchObject({ code: "not-file" });
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
  });

  it.each(["same-handle", "hardlink"] as const)("rejects %s aliases before changing source bytes", async kind => {
    const f = await fixture();
    let target = f.source;
    if (kind === "hardlink") {
      const alias = `${f.sourcePath}.alias`;
      await fs.link(f.sourcePath, alias);
      target = await fs.open(alias, "r+");
      handles.push(target);
    }
    await expect(copyFileHandle(f.source, target)).rejects.toMatchObject({ code: "path-alias" });
    expect(await fs.readFile(f.sourcePath)).toEqual(f.content);
  });
});
