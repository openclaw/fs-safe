import { createHash } from "node:crypto";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copyFileDescriptorSync, type CopyFileHandleOptions } from "../src/advanced.js";
import { useFileHandleTransferFixture } from "./helpers/file-handle-transfer.js";

const { fixture, trackHandle } = useFileHandleTransferFixture();

describe("borrowed file descriptor copying", () => {
  it("copies from zero through EOF while preserving descriptor cursors, modes, and the target suffix", async () => {
    const f = await fixture();
    fs.readSync(f.source.fd, Buffer.alloc(2), 0, 2, null);
    fs.readSync(f.target.fd, Buffer.alloc(3), 0, 3, null);
    const mode = fs.fstatSync(f.target.fd).mode;

    expect(copyFileDescriptorSync(f.source.fd, f.target.fd)).toBe(f.content.length);
    expect(fs.readFileSync(f.targetPath)).toEqual(
      Buffer.concat([f.content, Buffer.from(f.prior).subarray(f.content.length)]),
    );
    expect(fs.fstatSync(f.target.fd).mode).toBe(mode);
    const sourceNext = Buffer.alloc(1), targetNext = Buffer.alloc(1);
    fs.readSync(f.source.fd, sourceNext, 0, 1, null);
    fs.readSync(f.target.fd, targetNext, 0, 1, null);
    expect(sourceNext).toEqual(f.content.subarray(2, 3));
    expect(targetNext).toEqual(f.content.subarray(3, 4));
  });

  it("completes short reads and writes while observing each source byte once", async () => {
    const f = await fixture(Buffer.alloc(317).map((_, index) => index % 251), "");
    const read = fs.readSync, write = fs.writeSync;
    vi.spyOn(fs, "readSync").mockImplementation((fd, buffer, offset, length, position) =>
      read(fd, buffer, offset, Math.min(length, 19), position));
    vi.spyOn(fs, "writeSync").mockImplementation((fd, buffer, offset, length, position) =>
      write(fd, buffer, offset, Math.min(length, 7), position));
    const digest = createHash("sha256");

    expect(copyFileDescriptorSync(f.source.fd, f.target.fd, {
      onChunk: chunk => { digest.update(chunk); },
    })).toBe(f.content.length);
    expect(fs.readFileSync(f.targetPath)).toEqual(f.content);
    expect(digest.digest("hex")).toBe(createHash("sha256").update(f.content).digest("hex"));
  });

  it("enforces invalid, exceeded, zero, exact, and unlimited byte budgets", async () => {
    const f = await fixture("1234", "unchanged");
    for (const maxBytes of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => copyFileDescriptorSync(-1, -1, { maxBytes })).toThrow(RangeError);
    }
    for (const maxBytes of [0, 3]) {
      expect(() => copyFileDescriptorSync(f.source.fd, f.target.fd, { maxBytes }))
        .toThrow(expect.objectContaining({ code: "too-large" }));
    }
    expect(fs.readFileSync(f.targetPath, "utf8")).toBe(f.prior);
    expect(copyFileDescriptorSync(f.source.fd, f.target.fd, { maxBytes: 4 })).toBe(4);
    expect(copyFileDescriptorSync(f.source.fd, f.target.fd, { maxBytes: Infinity })).toBe(4);
    const empty = await fixture("", "retained");
    expect(copyFileDescriptorSync(empty.source.fd, empty.target.fd, { maxBytes: 0 })).toBe(0);
    expect(fs.readFileSync(empty.targetPath, "utf8")).toBe("retained");
  });

  it("copies large files with bounded scratch and rejects source growth before excess writes", async () => {
    const f = await fixture("", "");
    const size = 17 * 1024 * 1024;
    fs.truncateSync(f.sourcePath, size);
    const read = vi.spyOn(fs, "readSync");
    let grew = false;
    expect(() => copyFileDescriptorSync(f.source.fd, f.target.fd, {
      maxBytes: size,
      onChunk() {
        if (!grew) {
          grew = true;
          fs.appendFileSync(f.sourcePath, "excess");
        }
      },
    })).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(fs.fstatSync(f.target.fd).size).toBe(size);
    expect(fs.fstatSync(f.source.fd).size).toBe(size + 6);
    for (const call of read.mock.calls) expect(call[1].byteLength).toBeLessThanOrEqual(512 * 1024);
    read.mockRestore();
    expect(copyFileDescriptorSync(f.source.fd, f.target.fd)).toBe(size + 6);
    expect(fs.readFileSync(f.targetPath).equals(fs.readFileSync(f.sourcePath))).toBe(true);
  });

  it.each(["observer", "authority", "async-observer", "async-authority"] as const)(
    "propagates %s rejection before changing the current chunk", async kind => {
      const f = await fixture();
      const failure = new Error("synthetic callback refusal");
      const callback = kind.startsWith("async") ? async () => {} : () => { throw failure; };
      expect(() => copyFileDescriptorSync(f.source.fd, f.target.fd, kind.endsWith("observer")
        ? { onChunk: callback } : { assertBeforeMutation: callback }))
        .toThrow(kind.startsWith("async") ? TypeError : failure);
      expect(fs.readFileSync(f.targetPath, "utf8")).toBe(f.prior);
      expect(fs.fstatSync(f.source.fd).isFile()).toBe(true);
      expect(fs.fstatSync(f.target.fd).isFile()).toBe(true);
    },
  );

  it.each(["authority", "zero-write"] as const)("preserves only admitted bytes after %s failure", async kind => {
    const f = await fixture("abcdef", "");
    const failure = new Error("synthetic expired owner");
    const write = fs.writeSync;
    let authorized = true;
    vi.spyOn(fs, "writeSync").mockImplementation((fd, buffer, offset, length, position) => {
      if (!authorized) return 0;
      const written = write(fd, buffer, offset, Math.min(length, 2), position);
      authorized = false;
      return written;
    });
    expect(() => copyFileDescriptorSync(f.source.fd, f.target.fd, {
      assertBeforeMutation: kind === "authority" ? () => { if (!authorized) throw failure; } : undefined,
    })).toThrow(kind === "authority" ? failure : expect.objectContaining({ code: "helper-failed" }));
    expect(fs.readFileSync(f.targetPath, "utf8")).toBe("ab");
  });

  it.each(["pre-abort", "observer", "authority"] as const)("stops for %s cancellation before target mutation", async kind => {
    const f = await fixture();
    const controller = new AbortController();
    const aborted = new Error("synthetic abort");
    const abort = () => controller.abort(aborted);
    if (kind === "pre-abort") abort();
    expect(() => copyFileDescriptorSync(
      kind === "pre-abort" ? -1 : f.source.fd,
      kind === "pre-abort" ? -1 : f.target.fd,
      {
        signal: controller.signal,
        onChunk: kind === "observer" ? abort : undefined,
        assertBeforeMutation: kind === "authority" ? abort : undefined,
      },
    )).toThrow(aborted);
    expect(fs.readFileSync(f.targetPath, "utf8")).toBe(f.prior);
  });

  it("captures options once and invokes callbacks without a receiver or reading their call property", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const refusal = new Error("original authority");
    const reads = { maxBytes: 0, signal: 0, onChunk: 0, assertBeforeMutation: 0 };
    let authority = function (this: unknown) { expect(this).toBeUndefined(); throw refusal; };
    const observer = function (this: unknown) {
      expect(this).toBeUndefined();
      authority = () => {};
    };
    Object.defineProperty(observer, "call", { get() { throw new Error("unexpected call property"); } });
    const options = Object.create(Object.defineProperties({}, {
      signal: { get() { reads.signal++; return controller.signal; } },
      maxBytes: { get() { reads.maxBytes++; return f.content.length; } },
      onChunk: { get() { reads.onChunk++; return observer; } },
      assertBeforeMutation: { get() { reads.assertBeforeMutation++; return authority; } },
    })) as CopyFileHandleOptions;
    expect(() => copyFileDescriptorSync(f.source.fd, f.target.fd, options)).toThrow(refusal);
    expect(reads).toEqual({ maxBytes: 1, signal: 1, onChunk: 1, assertBeforeMutation: 1 });
    expect(fs.readFileSync(f.targetPath, "utf8")).toBe(f.prior);
  });

  it.skipIf(process.platform === "win32")("refuses directory sources and targets", async () => {
    const f = await fixture();
    const directory = trackHandle(await fsAsync.open(path.dirname(f.sourcePath), "r"));
    for (const [source, target] of [[directory.fd, f.target.fd], [f.source.fd, directory.fd]]) {
      expect(() => copyFileDescriptorSync(source!, target!))
        .toThrow(expect.objectContaining({ code: "not-file" }));
    }
    expect(fs.readFileSync(f.targetPath, "utf8")).toBe(f.prior);
  });

  it.each(["source", "target"] as const)("rejects inexact %s identities before writing", async which => {
    const f = await fixture();
    const inspect = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((fd, options) => {
      const stat = inspect(fd, options);
      if (fd === (which === "source" ? f.source.fd : f.target.fd)) {
        Object.defineProperty(stat, "ino", { value: Number(stat.ino) });
      }
      return stat;
    });
    expect(() => copyFileDescriptorSync(f.source.fd, f.target.fd))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fs.readFileSync(f.targetPath, "utf8")).toBe(f.prior);
  });

  it.each(["same-descriptor", "hardlink"] as const)("refuses %s aliases without writing", async kind => {
    const f = await fixture();
    let target = f.source;
    if (kind === "hardlink") {
      const alias = `${f.sourcePath}.alias`;
      await fsAsync.link(f.sourcePath, alias);
      target = trackHandle(await fsAsync.open(alias, "r+"));
    }
    expect(() => copyFileDescriptorSync(f.source.fd, target.fd))
      .toThrow(expect.objectContaining({ code: "path-alias" }));
    expect(fs.readFileSync(f.sourcePath)).toEqual(f.content);
  });
});
