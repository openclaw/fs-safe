import fs from "node:fs";
import fsAsync, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { preparePinnedWriteMode } from "../src/pinned-write-mode.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe.skipIf(process.platform === "win32")("private POSIX fallback payload policy", () => {
  beforeEach(() => {
    // Exercise Linux admission on POSIX hosts; real Linux package proof covers this route too.
    Object.defineProperty(process, "platform", { value: "linux" });
    configureFsSafeNative({ mode: "off" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetFsSafeNativeConfigForTest();
    __setFsSafeTestHooksForTest();
    Object.defineProperty(process, "platform", platform);
  });

  it("rejects callback widening before normalizing a restrictive private mode", async () => {
    const directory = await tempRoot("fs-safe-private-normalize-");
    const handle = await fsAsync.open(path.join(directory, "stage"), "wx", 0);
    try {
      await expect(preparePinnedWriteMode(handle, 0, () => fs.fchmodSync(handle.fd, 0o644), true))
        .rejects.toMatchObject({ code: "insecure-permissions" });
      expect(fs.fstatSync(handle.fd).mode & 0o7777).toBe(0o644);
      expect(fs.fstatSync(handle.fd).size).toBe(0);
    } finally { await handle.close(); }
  });

  it("normalizes a still-private restrictive stage before payload writes", async () => {
    const directory = await tempRoot("fs-safe-private-normalize-control-");
    const handle = await fsAsync.open(path.join(directory, "stage"), "wx", 0);
    try {
      const assertCurrent = await preparePinnedWriteMode(handle, 0, undefined, true);
      assertCurrent?.();
      expect(fs.fstatSync(handle.fd).mode & 0o7777).toBe(0o600);
    } finally { await handle.close(); }
  });

  for (const phase of ["first", "next", "done"] as const) {
    it.each([0o644, 0o700])(`rejects stage mode %i after producer ${phase}`, async (mode) => {
      const directory = await tempRoot("fs-safe-private-fallback-stream-");
      const scoped = await root(directory);
      let finished = false;
      let observed: Buffer | undefined;
      const prefix = phase === "first" ? "" : "prefix";
      async function* input() {
        let stage: string | undefined;
        try {
          if (prefix) yield Buffer.from(prefix);
          const stages = fs.readdirSync(directory).filter(name => /^\.fs-safe-.*\.tmp$/.test(name));
          expect(stages).toHaveLength(1);
          stage = path.join(directory, stages[0]!);
          fs.chmodSync(stage, mode);
          if (phase !== "done") yield Buffer.from("forbidden suffix");
        } finally {
          finished = true;
          if (stage) observed = fs.readFileSync(stage);
        }
      }
      await expect(scoped.create("target", input(), { private: true, mkdir: false }))
        .rejects.toMatchObject({ code: "insecure-permissions" });
      expect(finished).toBe(true);
      expect(observed?.toString()).toBe(prefix);
      expect(fs.readdirSync(directory)).toEqual([]);
    });
  }

  it.each([false, true])("rechecks private mode after a partial-write authority callback (atomic=%s)", async (atomic) => {
    const directory = await tempRoot("fs-safe-private-fallback-callback-");
    const scoped = await root(directory);
    const firstChunk = 512 * 1024;
    const content = Buffer.alloc(firstChunk + 32, 41);
    const handles: FileHandle[] = [];
    let written = 0;
    let changed = false;
    const open = fsAsync.open.bind(fsAsync);
    vi.spyOn(fsAsync, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (fs.fstatSync(handle.fd).isFile()) {
        handles.push(handle);
        const write = handle.write;
        vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
          const result = await Reflect.apply(write, handle, writeArgs);
          written += result.bytesWritten;
          return result;
        });
      }
      return handle;
    });
    await expect(scoped.create("target", content, {
      private: true, atomic, mkdir: false,
      assertBeforeMutation() {
        const handle = handles.find(item => item.fd >= 0 && fs.fstatSync(item.fd).size === firstChunk);
        if (!handle || changed) return;
        fs.fchmodSync(handle.fd, 0o644);
        changed = true;
      },
    })).rejects.toMatchObject({ code: "insecure-permissions" });
    expect(changed).toBe(true);
    expect(written).toBe(firstChunk);
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.every(handle => handle.fd === -1)).toBe(true);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("rejects changed ownership after the producer completes", async () => {
    const directory = await tempRoot("fs-safe-private-fallback-owner-");
    const scoped = await root(directory);
    let producerDone = false;
    const fstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      const stat = Reflect.apply(fstat, fs, args);
      if (producerDone && stat.isFile()) {
        stat.uid = typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1;
      }
      return stat;
    });
    async function* input() {
      yield Buffer.from("complete payload");
      producerDone = true;
    }
    await expect(scoped.create("target", input(), { private: true, mkdir: false }))
      .rejects.toMatchObject({ code: "not-owned" });
    expect(producerDone).toBe(true);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each([false, true])("rejects successful no-op final chmod (atomic=%s)", async (atomic) => {
    const directory = await tempRoot("fs-safe-private-fallback-final-");
    const scoped = await root(directory);
    const open = fsAsync.open.bind(fsAsync);
    let ignored = false;
    vi.spyOn(fsAsync, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (fs.fstatSync(handle.fd).isFile()) {
        const chmod = handle.chmod.bind(handle);
        vi.spyOn(handle, "chmod").mockImplementation(async mode => {
          if (mode === 0o400) { ignored = true; return; }
          await chmod(mode);
        });
      }
      return handle;
    });
    await expect(scoped.create("target", "complete payload", {
      private: true, atomic, mode: 0o400, mkdir: false,
    })).rejects.toMatchObject({ code: "insecure-permissions" });
    expect(ignored).toBe(true);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("preserves the complete destination and receipt after published permissions change", async () => {
    const directory = await tempRoot("fs-safe-private-fallback-published-");
    const scoped = await root(directory);
    const target = path.join(directory, "target");
    let published = false;
    __setFsSafeTestHooksForTest({ afterPinnedWriteFallbackRename: pathname => {
      expect(pathname).toBe(target);
      fs.chmodSync(pathname, 0o644);
      published = true;
    } });
    await expect(scoped.create("target", "complete payload", { private: true, atomic: true, mkdir: false }))
      .rejects.toMatchObject({
        code: "insecure-permissions",
        details: { publication: { status: "published" }, cleanup: { status: "not-needed", resources: "closed" } },
      });
    expect(published).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("complete payload");
    expect(fs.readdirSync(directory)).toEqual(["target"]);
  });

  for (const mode of [0, 0o400, 0o600, 0o700]) {
    it.each([false, true])(`preserves private final mode ${mode} (atomic=%s)`, async (atomic) => {
      const directory = await tempRoot("fs-safe-private-fallback-mode-");
      const scoped = await root(directory);
      const target = path.join(directory, "target");
      await scoped.create("target", "private payload", { private: true, atomic, mode, mkdir: false, durable: "file" });
      expect(fs.statSync(target).mode & 0o7777).toBe(mode);
      fs.chmodSync(target, 0o600);
      expect(fs.readFileSync(target, "utf8")).toBe("private payload");
      expect(fs.readdirSync(directory)).toEqual(["target"]);
    });
  }
});
