import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, itWin32, useTempDirs } from "./helpers/vitest.js";

vi.mock("node:child_process", () => {
  return {
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        kill(signal?: NodeJS.Signals): void;
        stdout: EventEmitter & { setEncoding: () => void };
        stderr: EventEmitter & { setEncoding: () => void };
      };
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.kill = () => undefined;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  };
});

const { tempRoot } = useTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");


afterEach(async () => {
  vi.restoreAllMocks();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("pinned write fallback coverage", () => {
  itPosix("writes buffers, creates only when missing, streams, and enforces limits when native mode is off", async () => {
    const { configureFsSafeNative } = await import("../src/native-config.js");
    const { runPinnedWriteHelper } = await import("../src/pinned-write.js");
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-pinned-write-fallback-");

    const created = await runPinnedWriteHelper({
      rootPath: root,
      relativeParentPath: "nested",
      basename: "created.txt",
      mkdir: true,
      mode: 0o600,
      overwrite: false,
      input: { kind: "buffer", data: "created", encoding: "utf8" },
    });
    expect(created.ino).toBeGreaterThan(0);
    await expect(fs.readFile(path.join(root, "nested", "created.txt"), "utf8")).resolves.toBe(
      "created",
    );
    await expect(
      runPinnedWriteHelper({
        rootPath: root,
        relativeParentPath: "nested",
        basename: "created.txt",
        mkdir: true,
        mode: 0o600,
        overwrite: false,
        input: { kind: "buffer", data: "again" },
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    const realOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).includes("streamed.txt")) {
        const realWrite = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation((async (
          buffer: Buffer,
          offset = 0,
          length = buffer.byteLength - offset,
          position?: number | null,
        ) => {
          const partialLength = Math.max(1, Math.ceil(length / 2));
          const result = await realWrite(buffer, offset, partialLength, position);
          return { bytesWritten: result.bytesWritten, buffer };
        }) as typeof handle.write);
      }
      return handle;
    });

    const streamed = await runPinnedWriteHelper({
      rootPath: root,
      relativeParentPath: "nested",
      basename: "streamed.txt",
      mkdir: true,
      mode: 0o600,
      overwrite: true,
      maxBytes: 16,
      input: { kind: "stream", stream: Readable.from(["stream", "ed"]) },
    });
    expect(streamed.dev).toBeGreaterThan(0);
    await expect(fs.readFile(path.join(root, "nested", "streamed.txt"), "utf8")).resolves.toBe(
      "streamed",
    );

    await expectFsSafeError(runPinnedWriteHelper({
        rootPath: root,
        relativeParentPath: "nested",
        basename: "too-large.txt",
        mkdir: true,
        mode: 0o600,
        overwrite: true,
        maxBytes: 2,
        input: { kind: "buffer", data: Buffer.from("large") },
      }), "too-large");
    await expect(fs.stat(path.join(root, "nested", "too-large.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  itPosix("uses the guarded fallback when native mode is off", async () => {
    const { configureFsSafeNative } = await import("../src/native-config.js");
    const { runPinnedWriteHelper } = await import("../src/pinned-write.js");
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-pinned-write-fallback-");

    await expect(
      runPinnedWriteHelper({
        rootPath: root,
        relativeParentPath: "",
        basename: "created.txt",
        mkdir: true,
        mode: 0o600,
        overwrite: true,
        input: { kind: "buffer", data: "created", encoding: "utf8" },
      }),
    ).resolves.toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
    await expect(fs.readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe(
      "created",
    );
  });

  itWin32("falls back on windows", async () => {
    const { runPinnedWriteHelper } = await import("../src/pinned-write.js");
    const root = await tempRoot("fs-safe-pinned-write-fallback-");
    await expect(runPinnedWriteHelper({
      rootPath: root,
      relativeParentPath: "nested",
      basename: "created.txt",
      mkdir: true,
      mode: 0o600,
      overwrite: false,
      input: { kind: "buffer", data: "created", encoding: "utf8" },
    })).resolves.toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
    await expect(fs.readFile(path.join(root, "nested", "created.txt"), "utf8")).resolves.toBe(
      "created",
    );
  });
});
