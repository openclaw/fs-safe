import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError, expectFsSafeErrorSync } from "./helpers/security.js";
import { itPosix, itWin32, useTempDirs } from "./helpers/vitest.js";
import {
  readSecretFileSync,
  tryReadSecretFileSync,
  writeSecretFileAtomic,
} from "../src/secret-file.js";
import { readSecretFile } from "../src/secret-read-async.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secret file refusal paths", () => {
  it("does not convert inspection failures into optional missing secrets", async () => {
    const root = await tempRoot("fs-safe-secret-inspect-failure-");
    const filePath = path.join(root, "token");
    await fs.writeFile(filePath, "secret");
    const denied = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    vi.spyOn(fsSync, "lstatSync").mockImplementation(() => {
      throw denied;
    });

    expect(() => tryReadSecretFileSync(filePath, "token")).toThrow(
      expect.objectContaining({ code: "invalid-path", cause: denied }),
    );
    expect(() => readSecretFileSync(filePath, "token")).toThrow(
      expect.objectContaining({ code: "invalid-path", cause: denied }),
    );
    expect(tryReadSecretFileSync("   ", "token")).toBeUndefined();
  });

  itPosix("rejects a broken allowed symlink when its target inspection fails", async () => {
    const root = await tempRoot("fs-safe-secret-broken-link-");
    const link = path.join(root, "token");
    await fs.symlink(path.join(root, "missing"), link);
    expect(() => readSecretFileSync(link, "token")).toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
  });

  itPosix("refuses symlinked roots and nested secret directories", async () => {
    const root = await tempRoot("fs-safe-secret-write-link-");
    const realRoot = path.join(root, "real");
    const linkedRoot = path.join(root, "linked-root");
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, linkedRoot);
    await expect(
      writeSecretFileAtomic({
        rootDir: linkedRoot,
        filePath: path.join(linkedRoot, "token"),
        content: "secret",
      }),
    ).rejects.toThrow("must not be a symlink");

    const nestedLink = path.join(realRoot, "nested");
    await fs.symlink(root, nestedLink);
    await expect(
      writeSecretFileAtomic({
        rootDir: realRoot,
        filePath: path.join(nestedLink, "token"),
        content: "secret",
      }),
    ).rejects.toThrow("must not be a symlink");
  });

  it("refuses non-directory roots and nested directory components", async () => {
    const root = await tempRoot("fs-safe-secret-write-nondir-");
    const rootFile = path.join(root, "root-file");
    await fs.writeFile(rootFile, "not a directory");
    await expect(
      writeSecretFileAtomic({
        rootDir: rootFile,
        filePath: path.join(rootFile, "token"),
        content: "secret",
      }),
    ).rejects.toThrow();

    const component = path.join(root, "component");
    await fs.writeFile(component, "not a directory");
    await expect(
      writeSecretFileAtomic({
        rootDir: root,
        filePath: path.join(component, "token"),
        content: "secret",
      }),
    ).rejects.toThrow("must be a directory");
  });

  it("refuses overwriting a directory at the final secret path", async () => {
    const root = await tempRoot("fs-safe-secret-write-target-");
    const filePath = path.join(root, "token");
    await fs.mkdir(filePath);
    await expect(
      writeSecretFileAtomic({ rootDir: root, filePath, content: "secret" }),
    ).rejects.toThrow("must be a regular file");
    expect((await fs.stat(filePath)).isDirectory()).toBe(true);
  });

  itPosix("refuses overwriting a symlink at the final secret path", async () => {
    const root = await tempRoot("fs-safe-secret-write-target-link-");
    const outside = await tempRoot("fs-safe-secret-write-outside-");
    const outsideFile = path.join(outside, "token");
    const filePath = path.join(root, "token");
    await fs.writeFile(outsideFile, "outside");
    await fs.symlink(outsideFile, filePath);
    await expect(
      writeSecretFileAtomic({ rootDir: root, filePath, content: "replacement" }),
    ).rejects.toThrow("must not be a symlink");
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });

  it("maps a vanished path between preview and pinned open to not-found", async () => {
    const root = await tempRoot("fs-safe-secret-open-vanish-");
    const filePath = path.join(root, "token");
    await fs.writeFile(filePath, "secret");
    vi.spyOn(fsSync, "realpathSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("vanished"), { code: "ENOENT" });
    });
    expect(() => readSecretFileSync(filePath, "token")).toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
  });

  itPosix("rejects a secret path retargeted after the preview in sync and async readers", async () => {
    const root = await tempRoot("fs-safe-secret-preview-retarget-");
    const originalPath = path.join(root, "original");
    const replacementPath = path.join(root, "replacement");
    const syncLink = path.join(root, "sync-token");
    const asyncLink = path.join(root, "async-token");
    await fs.writeFile(originalPath, "original");
    await fs.writeFile(replacementPath, "replacement");
    await fs.symlink(originalPath, syncLink);
    await fs.symlink(originalPath, asyncLink);

    const realpathSync = fsSync.realpathSync.bind(fsSync);
    vi.spyOn(fsSync, "realpathSync").mockImplementationOnce((candidate, options) => {
      fsSync.unlinkSync(syncLink);
      fsSync.symlinkSync(replacementPath, syncLink);
      return realpathSync(candidate, options as never);
    });
    expectFsSafeErrorSync(() => readSecretFileSync(syncLink, "sync token"), "path-mismatch");

    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementationOnce(async (candidate, options) => {
      await fs.unlink(asyncLink);
      await fs.symlink(replacementPath, asyncLink);
      return await realpath(candidate, options as never);
    });
    await expectFsSafeError(readSecretFile(asyncLink, "async token"), "path-mismatch");
  });

  it("rejects a different descriptor identity during post-write verification", async () => {
    const root = await tempRoot("fs-safe-secret-write-identity-");
    const filePath = path.join(root, "token");
    const otherPath = path.join(root, "other");
    await fs.writeFile(otherPath, "other");
    const otherStat = await fs.stat(otherPath);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (path.basename(String(args[0])) === "token" && typeof args[1] === "number") {
        vi.spyOn(handle, "stat").mockResolvedValueOnce(otherStat);
      }
      return handle;
    });
    await expect(
      writeSecretFileAtomic({ rootDir: root, filePath, content: "secret" }),
    ).rejects.toMatchObject({ code: "path-mismatch" });
  });

  itPosix("rejects an insecure mode reported after post-write chmod", async () => {
    const root = await tempRoot("fs-safe-secret-write-mode-");
    const filePath = path.join(root, "token");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (path.basename(String(args[0])) === "token" && typeof args[1] === "number") {
        const actual = await handle.stat();
        vi.spyOn(handle, "stat")
          .mockResolvedValueOnce(actual)
          .mockResolvedValueOnce({ ...actual, mode: 0o100644 } as never);
      }
      return handle;
    });
    await expect(
      writeSecretFileAtomic({ rootDir: root, filePath, content: "secret" }),
    ).rejects.toThrow("has insecure permissions 644");
  });

  itWin32("publishes the secret when POSIX mode enforcement is unavailable", async () => {
    const root = await tempRoot("fs-safe-secret-write-mode-win32-");
    const filePath = path.join(root, "token");

    await expect(
      writeSecretFileAtomic({ rootDir: root, filePath, content: "secret" }),
    ).resolves.toBeUndefined();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("secret");
    expect(readSecretFileSync(filePath, "token")).toBe("secret");
  });
});
