import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
  statRegularFileSync,
} from "../src/regular-file.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("regular file refusal and race handling", () => {
  it("distinguishes missing paths from inspection errors and non-files", async () => {
    const root = await tempRoot("fs-safe-regular-stat-");
    const missing = path.join(root, "missing");
    await expect(statRegularFile(missing)).resolves.toEqual({ missing: true });
    expect(statRegularFileSync(missing)).toEqual({ missing: true });
    await expect(statRegularFile(root)).rejects.toThrow("path must be a regular file");
    expect(() => statRegularFileSync(root)).toThrow("path must be a regular file");

    const denied = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(denied);
    await expect(statRegularFile(missing)).rejects.toBe(denied);
    vi.spyOn(fsSync, "lstatSync").mockImplementationOnce(() => {
      throw denied;
    });
    expect(() => statRegularFileSync(missing)).toThrow(denied);
  });

  it("reads at the exact cap and rejects missing paths in both APIs", async () => {
    const root = await tempRoot("fs-safe-regular-read-");
    const filePath = path.join(root, "value");
    const missing = path.join(root, "missing");
    await fs.writeFile(filePath, "abc");

    await expect(readRegularFile({ filePath, maxBytes: 3 })).resolves.toMatchObject({
      buffer: Buffer.from("abc"),
    });
    expect(readRegularFileSync({ filePath }).buffer).toEqual(Buffer.from("abc"));
    await expect(readRegularFile({ filePath: missing })).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => readRegularFileSync({ filePath: missing })).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("reports a vanished file as a path mismatch after the preview check", async () => {
    const root = await tempRoot("fs-safe-regular-vanish-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "abc");
    const missing = Object.assign(new Error("vanished"), { code: "ENOENT" });
    vi.spyOn(fs, "open").mockRejectedValueOnce(missing);
    await expect(readRegularFile({ filePath })).rejects.toMatchObject({ code: "path-mismatch" });

    const realLstat = fs.lstat.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]) === filePath && ++calls === 2) throw missing;
      return await realLstat(...args);
    });
    await expect(readRegularFile({ filePath })).rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("reports sync disappearance before and after open as a path mismatch", async () => {
    const root = await tempRoot("fs-safe-regular-sync-vanish-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "abc");
    const missing = Object.assign(new Error("vanished"), { code: "ENOENT" });

    vi.spyOn(fsSync, "openSync").mockImplementationOnce(() => {
      throw missing;
    });
    expect(() => readRegularFileSync({ filePath })).toThrow(
      expect.objectContaining({ code: "path-mismatch" }),
    );

    const realLstatSync = fsSync.lstatSync.bind(fsSync);
    let calls = 0;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) === filePath && ++calls === 2) throw missing;
      return realLstatSync(...args);
    });
    expect(() => readRegularFileSync({ filePath })).toThrow(
      expect.objectContaining({ code: "path-mismatch" }),
    );
  });

  it("preserves unexpected bounded-read errors instead of relabeling them", async () => {
    const root = await tempRoot("fs-safe-regular-read-error-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "abc");
    const realOpen = fs.open.bind(fs);
    const failure = Object.assign(new Error("read failed"), { code: "EIO" });
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "read").mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(readRegularFile({ filePath, maxBytes: 3 })).rejects.toBe(failure);
  });

  it("does not create or extend a file beyond its configured maximum", async () => {
    const root = await tempRoot("fs-safe-regular-append-limit-");
    const asyncPath = path.join(root, "async");
    const syncPath = path.join(root, "sync");
    await appendRegularFile({ filePath: asyncPath, content: "abcd", maxFileBytes: 3 });
    appendRegularFileSync({ filePath: syncPath, content: Buffer.from("abcd"), maxFileBytes: 3 });
    await expect(fs.access(asyncPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fsSync.existsSync(syncPath)).toBe(false);

    await fs.writeFile(asyncPath, "ab");
    await fs.writeFile(syncPath, "ab");
    await appendRegularFile({ filePath: asyncPath, content: "cd", maxFileBytes: 3 });
    appendRegularFileSync({ filePath: syncPath, content: "cd", maxFileBytes: 3 });
    await expect(fs.readFile(asyncPath, "utf8")).resolves.toBe("ab");
    expect(fsSync.readFileSync(syncPath, "utf8")).toBe("ab");
  });

  itPosix("refuses symlink, directory, and hardlink append targets", async () => {
    const root = await tempRoot("fs-safe-regular-append-refuse-");
    const target = path.join(root, "target");
    const symlink = path.join(root, "symlink");
    const hardlink = path.join(root, "hardlink");
    await fs.writeFile(target, "original");
    await fs.symlink(target, symlink);
    await fs.link(target, hardlink);

    await expect(appendRegularFile({ filePath: symlink, content: "x" })).rejects.toThrow(
      "Refusing to append through symlink",
    );
    expect(() => appendRegularFileSync({ filePath: symlink, content: "x" })).toThrow(
      "Refusing to append through symlink",
    );
    await expect(appendRegularFile({ filePath: root, content: "x" })).rejects.toThrow(
      "Refusing to append to non-file",
    );
    expect(() => appendRegularFileSync({ filePath: root, content: "x" })).toThrow(
      "Refusing to append to non-file",
    );
    await expect(appendRegularFile({ filePath: hardlink, content: "x" })).rejects.toThrow(
      "Refusing to append to hardlinked file",
    );
    expect(() => appendRegularFileSync({ filePath: hardlink, content: "x" })).toThrow(
      "Refusing to append to hardlinked file",
    );
    await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
  });

  it("refuses an async append if the path is replaced before open", async () => {
    const root = await tempRoot("fs-safe-regular-append-swap-");
    const filePath = path.join(root, "value");
    const oldPath = path.join(root, "old");
    await fs.writeFile(filePath, "original");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.rename(filePath, oldPath);
      await fs.writeFile(filePath, "replacement");
      return await realOpen(...args);
    });

    await expect(appendRegularFile({ filePath, content: "x" })).rejects.toThrow(
      "Refusing to append after file changed",
    );
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(oldPath, "utf8")).resolves.toBe("original");
  });

  itPosix("rejects symlinked append parents when requested", async () => {
    const root = await tempRoot("fs-safe-regular-parent-");
    const realDir = path.join(root, "real");
    const linkDir = path.join(root, "link");
    await fs.mkdir(realDir);
    await fs.symlink(realDir, linkDir);
    const filePath = path.join(linkDir, "value");

    await expect(
      appendRegularFile({ filePath, content: "x", rejectSymlinkParents: true }),
    ).rejects.toThrow("Refusing to append under");
    expect(() =>
      appendRegularFileSync({ filePath, content: "x", rejectSymlinkParents: true }),
    ).toThrow("Refusing to append under");
    await expect(fs.access(path.join(realDir, "value"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("omits O_NOFOLLOW when the platform constants do not provide it", () => {
    expect(
      resolveRegularFileAppendFlags({ O_APPEND: 1, O_CREAT: 2, O_WRONLY: 4 }),
    ).toBe(7);
  });

  it("rechecks the async size limit after opening the file", async () => {
    const root = await tempRoot("fs-safe-regular-post-open-size-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "ab");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      await fs.appendFile(filePath, "cd");
      return handle;
    });
    await expect(readRegularFile({ filePath, maxBytes: 3 })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("rechecks append limits after a concurrent growth", async () => {
    const root = await tempRoot("fs-safe-regular-post-open-append-");
    const asyncPath = path.join(root, "async");
    const syncPath = path.join(root, "sync");
    await fs.writeFile(asyncPath, "a");
    await fs.writeFile(syncPath, "a");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      await fs.appendFile(asyncPath, "bc");
      return handle;
    });
    await appendRegularFile({ filePath: asyncPath, content: "d", maxFileBytes: 3 });
    await expect(fs.readFile(asyncPath, "utf8")).resolves.toBe("abc");

    const realOpenSync = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementationOnce((...args) => {
      const fd = realOpenSync(...args);
      fsSync.appendFileSync(syncPath, "bc");
      return fd;
    });
    appendRegularFileSync({ filePath: syncPath, content: "d", maxFileBytes: 3 });
    expect(fsSync.readFileSync(syncPath, "utf8")).toBe("abc");
  });

  it("wraps bounded-read growth with the compatibility error", async () => {
    const root = await tempRoot("fs-safe-regular-bounded-growth-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "abc");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "read").mockImplementationOnce(async (buffer) => {
        Buffer.from("abcd").copy(buffer as Buffer);
        return { bytesRead: 4, buffer };
      });
      return handle;
    });
    await expect(readRegularFile({ filePath, maxBytes: 3 })).rejects.toMatchObject({
      code: "too-large",
      message: `File exceeds 3 bytes: ${filePath}`,
      cause: expect.objectContaining({ code: "too-large" }),
    });
  });

  it("preserves an unexpected post-open path inspection error", async () => {
    const root = await tempRoot("fs-safe-regular-post-open-inspect-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "abc");
    const denied = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    const realLstat = fs.lstat.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]) === filePath && ++calls === 2) throw denied;
      return await realLstat(...args);
    });
    await expect(readRegularFile({ filePath })).rejects.toBe(denied);
  });

  it("preserves an unexpected uncapped handle read error", async () => {
    const root = await tempRoot("fs-safe-regular-uncapped-read-error-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "abc");
    const failure = Object.assign(new Error("read failed"), { code: "EIO" });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "readFile").mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(readRegularFile({ filePath })).rejects.toBe(failure);
  });

  it("refuses a path swapped to a directory after its descriptor opens", async () => {
    const root = await tempRoot("fs-safe-regular-read-directory-swap-");
    const filePath = path.join(root, "value");
    const oldPath = path.join(root, "old");
    await fs.writeFile(filePath, "abc");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      await fs.rename(filePath, oldPath);
      await fs.mkdir(filePath);
      return handle;
    });
    await expect(readRegularFile({ filePath })).rejects.toThrow("File is not a regular file");
  });

  it("rechecks the sync size limit after opening the descriptor", async () => {
    const root = await tempRoot("fs-safe-regular-sync-post-open-size-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "ab");
    const realOpen = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementationOnce((...args) => {
      const fd = realOpen(...args);
      fsSync.appendFileSync(filePath, "cd");
      return fd;
    });
    expect(() => readRegularFileSync({ filePath, maxBytes: 3 })).toThrow(
      expect.objectContaining({ code: "too-large" }),
    );
  });

  it("refuses an append descriptor reported as a non-file", async () => {
    const root = await tempRoot("fs-safe-regular-append-opened-type-");
    const filePath = path.join(root, "value");
    await fs.writeFile(filePath, "abc");
    const directoryStat = await fs.stat(root);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "stat").mockResolvedValueOnce(directoryStat);
      return handle;
    });
    await expect(appendRegularFile({ filePath, content: "d" })).rejects.toThrow(
      "Refusing to append to non-file",
    );
  });
});
