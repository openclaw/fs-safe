import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { configureFsSafeNative } from "../../src/native-config.js";
import { __setNativeLoaderForTest, type NativeBinding } from "../../src/native.js";

export const hashIdentity = { dev: 7n, ino: 9007199254806528n };
export const abcHash = {
  bytes: 3,
  digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};
export type HashBoundary = "preview" | "descriptor" | "current";
export type HashSample = Partial<typeof hashIdentity> & { kind?: "symlink" | "not-file" };
export type HashSamples = Partial<Record<HashBoundary, (HashSample | Error)[]>>;

export function expectedHashOpenFlags(): number {
  return fsSync.constants.O_RDONLY | (process.platform === "win32" ? 0 :
    (fsSync.constants.O_NOFOLLOW ?? 0) | (fsSync.constants.O_NONBLOCK ?? 0));
}

// Real files, opens, stats, reads and closes; only the delivered identity/type
// observations are modeled. A mocked binding proves dispatch, not native hashing.
export async function observeHashPath(
  directory: string,
  samples: HashSamples = {},
  mode: "off" | "mock-native" = "off",
) {
  const filePath = path.join(directory, "payload.bin");
  await fs.writeFile(filePath, "abc");
  const events: string[] = [];
  const counts = { preview: 0, descriptor: 0, current: 0 };
  const observations: { boundary: HashBoundary; bigint: boolean; dev: unknown; ino: unknown }[] = [];
  const descriptors: number[] = [];
  const handles: fs.FileHandle[] = [];
  const read = vi.fn();
  const close = vi.fn();
  const nativeHash = vi.fn(async (_fd: number) => {
    events.push("native");
    return abcHash;
  });
  const loader = vi.fn(() => ({ sha256File: nativeHash }) as unknown as NativeBinding);
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode: mode === "off" ? "off" : "auto" });

  function observe(boundary: HashBoundary, stat: Stats | BigIntStats, bigint: boolean) {
    events.push(boundary);
    const sequence = samples[boundary];
    const attempt = counts[boundary]++;
    const sample = sequence?.[Math.min(attempt, sequence.length - 1)] ?? {};
    if (sample instanceof Error) throw sample;
    const identity = { ...hashIdentity, ...sample };
    stat.dev = bigint ? identity.dev : Number(identity.dev);
    stat.ino = bigint ? identity.ino : Number(identity.ino);
    if (sample.kind) {
      stat.isSymbolicLink = () => sample.kind === "symlink";
      stat.isFile = () => false;
    }
    observations.push({ boundary, bigint, dev: stat.dev, ino: stat.ino });
    return stat;
  }

  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    if (args[0] !== filePath) return stat;
    return observe(handles.length === 0 ? "preview" : "current", stat, args[1]?.bigint === true);
  });
  const actualOpen = fs.open.bind(fs);
  const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    if (args[0] !== filePath) return handle;
    events.push("open");
    handles.push(handle);
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async (options) => {
      const result = await stat(options);
      if (!options?.bigint) {
        events.push("hash-stat");
        return result;
      }
      descriptors.push(handle.fd);
      return observe("descriptor", result, true);
    });
    const actualRead = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
      events.push("read");
      read(handle.fd);
      return await actualRead(...readArgs);
    });
    const actualClose = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      events.push("close");
      close(handle.fd);
      await actualClose();
    });
    return handle;
  });
  return { filePath, events, counts, observations, descriptors, handles, open, read, close, nativeHash, loader };
}
