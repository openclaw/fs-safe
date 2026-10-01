import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic } from "../src/atomic.js";
import { bindHandle } from "./helpers/file-handle-proxy.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

function trackHandles() {
  const handles: FileHandle[] = [], owned = new Set<FileHandle>();
  return {
    handles,
    add(handle: FileHandle): FileHandle {
      handles.push(handle);
      owned.add(handle);
      const close = handle.close.bind(handle);
      handle.close = () => {
        expect(owned.delete(handle)).toBe(true);
        return close();
      };
      return handle;
    },
    async cleanup(): Promise<void> {
      for (const handle of owned) {
        try { await handle.close(); } catch { /* Ownership was consumed before the close attempt. */ }
      }
    },
  };
}

describe("public copy fallback result observations", () => {
  it("uses the second bytesWritten observation to advance real short writes", async () => {
    const root = await tempRoot("fs-safe-copy-write-observations-");
    const dest = path.join(root, "dest"), payload = Buffer.from("replacement-data");
    await fs.writeFile(dest, "original");
    const ownership = trackHandles();
    const { handles } = ownership;
    const writes: Array<{ actual: number; observations: number }> = [];
    let dispatched = 0;
    const promises = {
      ...fs,
      async rename() { throw Object.assign(new Error("rename denied"), { code: "EPERM" }); },
      async open(candidate: fsSync.PathLike, flags: string | number, mode?: fsSync.Mode) {
        const handle = ownership.add(await fs.open(candidate, flags, mode));
        if (String(candidate) !== dest) return handle;
        return bindHandle(handle, {
          write: (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
            expect(offset).toBe(dispatched);
            expect(position).toBe(dispatched);
            expect(length).toBe(payload.length - dispatched);
            const actual = await handle.write(buffer, offset, Math.min(2, length), position);
            expect(actual.bytesWritten).toBeGreaterThan(0);
            expect(actual.bytesWritten).toBeLessThanOrEqual(Math.min(2, length));
            const record = { actual: actual.bytesWritten, observations: 0 };
            writes.push(record);
            dispatched += actual.bytesWritten;
            return {
              buffer: actual.buffer,
              get bytesWritten() { return ++record.observations === 1 ? record.actual + 1 : record.actual; },
            };
          }) as unknown as FileHandle["write"],
        });
      },
    };
    try {
      await expect(replaceFileAtomic({
        filePath: dest, content: payload, fileSystem: { promises },
        copyFallbackOnPermissionError: true, copyFallbackRestore: "none",
        assertBeforeMutation() {},
      })).resolves.toEqual({ method: "copy-fallback" });
      expect(writes.length).toBeGreaterThan(1);
      expect(writes.every(record => record.observations === 2)).toBe(true);
      expect(dispatched).toBe(payload.length);
      expect((await fs.readFile(dest)).equals(payload)).toBe(true);
      expect(await fs.readdir(root)).toEqual(["dest"]);
      expect(handles.every(handle => handle.fd === -1)).toBe(true);
    } finally {
      await ownership.cleanup();
    }
  });

  it("rejects a zero first bytesWritten observation without reading it again", async () => {
    const root = await tempRoot("fs-safe-copy-zero-observation-");
    const dest = path.join(root, "dest");
    await fs.writeFile(dest, "original");
    const ownership = trackHandles();
    const { handles } = ownership;
    let writes = 0, observations = 0;
    const promises = {
      ...fs,
      async rename() { throw Object.assign(new Error("rename denied"), { code: "EPERM" }); },
      async open(candidate: fsSync.PathLike, flags: string | number, mode?: fsSync.Mode) {
        const handle = ownership.add(await fs.open(candidate, flags, mode));
        if (String(candidate) !== dest) return handle;
        return bindHandle(handle, {
          write: (async (buffer: Buffer, offset: number, _length: number, position: number | null) => {
            writes++;
            const actual = await handle.write(buffer, offset, 0, position);
            expect(actual.bytesWritten).toBe(0);
            return {
              buffer: actual.buffer,
              get bytesWritten() {
                if (++observations !== 1) throw new Error("zero result was observed again");
                return actual.bytesWritten;
              },
            };
          }) as unknown as FileHandle["write"],
        });
      },
    };
    try {
      await expect(replaceFileAtomic({
        filePath: dest, content: "replacement", fileSystem: { promises },
        copyFallbackOnPermissionError: true, copyFallbackRestore: "none",
        assertBeforeMutation() {},
      })).rejects.toThrow("Copy fallback write made no progress");
      expect(writes).toBe(1);
      expect(observations).toBe(1);
      expect(await fs.readFile(dest, "utf8")).toBe("");
      expect(await fs.readdir(root)).toEqual(["dest"]);
      expect(handles.every(handle => handle.fd === -1)).toBe(true);
    } finally {
      await ownership.cleanup();
    }
  });

  it("observes bytesRead once per bounded snapshot chunk and restores all original bytes", async () => {
    const root = await tempRoot("fs-safe-copy-read-observations-");
    const dest = path.join(root, "dest"), original = Buffer.from("original retained snapshot");
    await fs.writeFile(dest, original, { mode: 0o600 });
    const identity = await fs.stat(dest, { bigint: true });
    const ownership = trackHandles();
    const { handles } = ownership;
    const reads: Array<{ position: number | null; requested: number; actual: number; observations: number }> = [];
    const failure = new Error("replacement write failed");
    let writes = 0, captured = 0;
    const promises = {
      ...fs,
      async rename() { throw Object.assign(new Error("rename denied"), { code: "EPERM" }); },
      async open(candidate: fsSync.PathLike, flags: string | number, mode?: fsSync.Mode) {
        const handle = ownership.add(await fs.open(candidate, flags, mode));
        if (String(candidate) !== dest) return handle;
        return bindHandle(handle, {
          read: (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
            expect(offset).toBe(0);
            expect(position).toBe(captured);
            const actual = await handle.read(buffer, offset, Math.min(3, length), position);
            const record = { position, requested: length, actual: actual.bytesRead, observations: 0 };
            reads.push(record);
            captured += actual.bytesRead;
            return {
              buffer: actual.buffer,
              get bytesRead() { record.observations++; return record.actual; },
            };
          }) as unknown as FileHandle["read"],
          write: (async (...args: Parameters<FileHandle["write"]>) => {
            if (++writes === 1) throw failure;
            return await handle.write(...args);
          }) as FileHandle["write"],
        });
      },
    };
    try {
      await expect(replaceFileAtomic({
        filePath: dest, content: "replacement", fileSystem: { promises },
        copyFallbackOnPermissionError: true, copyFallbackRestore: "restore-original",
        maxRestoreBytes: original.length, assertBeforeMutation() {},
      })).rejects.toMatchObject({ code: "helper-failed", details: { cleanup: "restored" }, cause: failure });
      expect(reads.length).toBeGreaterThan(2);
      expect(reads.every(record => record.observations === 1)).toBe(true);
      expect(reads.every(record => record.requested <= original.length + 1)).toBe(true);
      expect(reads.at(-1)?.actual).toBe(0);
      expect(captured).toBe(original.length);
      expect(writes).toBeGreaterThan(1);
      expect((await fs.readFile(dest)).equals(original)).toBe(true);
      const restored = await fs.stat(dest, { bigint: true });
      expect([restored.dev, restored.ino]).toEqual([identity.dev, identity.ino]);
      expect(await fs.readdir(root)).toEqual(["dest"]);
      expect(handles.every(handle => handle.fd === -1)).toBe(true);
    } finally {
      await ownership.cleanup();
    }
  }, process.platform === "win32" ? 30_000 : undefined);
});
