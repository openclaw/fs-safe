import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FsSafeError,
  openPinnedFileSync,
  openRootFile,
  openRootFileSync,
  pathScope,
  resolveAbsolutePathForRead,
  root as openRoot,
} from "../src/index.js";

type TempLayout = {
  outside: string;
  outsideFile: string;
  root: string;
};

const tempDirs: string[] = [];

const TRAVERSAL_PAYLOADS = [
  "../secret.txt",
  "../../secret.txt",
  "nested/../../secret.txt",
  "nested/../../../secret.txt",
  "./../secret.txt",
  "nested/..//../secret.txt",
  "nested/%2e%2e/secret.txt",
  "%2e%2e/secret.txt",
  "%2e%2e%2fsecret.txt",
  "..%2fsecret.txt",
  "%252e%252e%252fsecret.txt",
  "..%00/secret.txt",
  "..\\secret.txt",
  "nested\\..\\..\\secret.txt",
  "C:\\Windows\\win.ini",
  "\\\\server\\share\\secret.txt",
] as const;

const LIST_TRAVERSAL_PAYLOADS = [
  "..",
  "../",
  "../../",
  "nested/../..",
  "nested/../../outside",
  "%2e%2e",
  "%2e%2e%2f",
  "..\\",
  "C:\\Windows",
  "\\\\server\\share",
] as const;

async function makeTempLayout(prefix: string): Promise<TempLayout> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-root-`));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-outside-`));
  tempDirs.push(root, outside);
  const outsideFile = path.join(outside, "secret.txt");
  await fsp.writeFile(outsideFile, "outside secret");
  return { outside, outsideFile, root };
}

async function closeIfOpen(value: unknown): Promise<void> {
  if (typeof value === "object" && value !== null && "handle" in value) {
    const handle = (value as { handle?: { close(): Promise<void> } }).handle;
    if (handle) {
      await handle.close();
    }
  }
}

function expectFsSafeCode(error: unknown, codes: readonly string[]): void {
  expect(error).toBeInstanceOf(FsSafeError);
  expect(codes).toContain((error as FsSafeError).code);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { force: true, recursive: true })));
});

describe("OpenClaw read bypass parity", () => {
  it("rejects a payload corpus of traversal, encoded, NUL, Windows, and UNC read attempts", async () => {
    const layout = await makeTempLayout("fs-safe-read-payloads");
    await fsp.mkdir(path.join(layout.root, "nested"), { recursive: true });
    await fsp.writeFile(path.join(layout.root, "nested", "safe.txt"), "safe");
    const safeRoot = await openRoot(layout.root);

    for (const payload of TRAVERSAL_PAYLOADS) {
      await expect(safeRoot.read(payload), `read(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.open(payload), `open(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.stat(payload), `stat(${payload})`).rejects.toBeTruthy();
    }
  });

  it("rejects a payload corpus of traversal, encoded, Windows, and UNC directory listing attempts", async () => {
    const layout = await makeTempLayout("fs-safe-list-payloads");
    await fsp.mkdir(path.join(layout.root, "nested"), { recursive: true });
    await fsp.writeFile(path.join(layout.root, "nested", "safe.txt"), "safe");
    const safeRoot = await openRoot(layout.root);

    for (const payload of LIST_TRAVERSAL_PAYLOADS) {
      await expect(safeRoot.list(payload), `list(${payload})`).rejects.toBeTruthy();
    }
  });

  it("rejects traversal across root read, open, stat, list, and path scope APIs", async () => {
    const layout = await makeTempLayout("fs-safe-read-traversal");
    const safeRoot = await openRoot(layout.root);
    const scope = pathScope(layout.root, { label: "test root" });

    await expect(safeRoot.read("../secret.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "invalid-path", "path-alias"]);
      return true;
    });
    await expect(safeRoot.open("../secret.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "invalid-path", "path-alias"]);
      return true;
    });
    await expect(safeRoot.stat("../secret.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "invalid-path", "path-alias"]);
      return true;
    });
    await expect(safeRoot.list(".." as string)).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "invalid-path", "path-alias"]);
      return true;
    });
    await expect(scope.files(["../secret.txt"])).resolves.toMatchObject({ ok: false });
  });

  it("rejects symlink parents across root read/open/stat/list APIs", async () => {
    const layout = await makeTempLayout("fs-safe-read-symlink-parent");
    await fsp.symlink(layout.outside, path.join(layout.root, "link"), "dir");
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.read("link/secret.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "symlink"]);
      return true;
    });
    await expect(safeRoot.open("link/secret.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "symlink"]);
      return true;
    });
    await expect(safeRoot.stat("link/secret.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "symlink"]);
      return true;
    });
    await expect(safeRoot.list("link")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "symlink"]);
      return true;
    });
  });

  it("rejects final symlink leaves for root read/open/stat and direct root-file APIs", async () => {
    const layout = await makeTempLayout("fs-safe-read-symlink-leaf");
    const linkPath = path.join(layout.root, "secret-link.txt");
    await fsp.symlink(layout.outsideFile, linkPath, "file");
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.read("secret-link.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "symlink"]);
      return true;
    });
    await expect(safeRoot.open("secret-link.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "symlink"]);
      return true;
    });
    await expect(safeRoot.stat("secret-link.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "symlink"]);
      return true;
    });

    const rootRealPath = await fsp.realpath(layout.root);
    const syncOpened = openRootFileSync({
      absolutePath: linkPath,
      boundaryLabel: "root",
      rootPath: layout.root,
      rootRealPath,
    });
    expect(syncOpened.ok).toBe(false);
    if (syncOpened.ok) {
      fs.closeSync(syncOpened.fd);
    }

    const asyncOpened = await openRootFile({
      absolutePath: linkPath,
      boundaryLabel: "root",
      rootPath: layout.root,
      rootRealPath,
    });
    expect(asyncOpened.ok).toBe(false);
    if (asyncOpened.ok) {
      await asyncOpened.handle.close();
    }

    const pinnedOpened = openPinnedFileSync({ filePath: linkPath, rejectPathSymlink: true });
    expect(pinnedOpened.ok).toBe(false);
    if (pinnedOpened.ok) {
      fs.closeSync(pinnedOpened.fd);
    }
  });

  it("rejects absolute outside files across root read, open, stat, and direct root-file APIs", async () => {
    const layout = await makeTempLayout("fs-safe-absolute-outside");
    const safeRoot = await openRoot(layout.root);
    const rootRealPath = await fsp.realpath(layout.root);

    await expect(safeRoot.read(layout.outsideFile)).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "invalid-path"]);
      return true;
    });
    await expect(safeRoot.open(layout.outsideFile)).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "invalid-path"]);
      return true;
    });
    await expect(safeRoot.stat(layout.outsideFile)).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "invalid-path"]);
      return true;
    });

    const syncOpened = openRootFileSync({
      absolutePath: layout.outsideFile,
      boundaryLabel: "root",
      rootPath: layout.root,
      rootRealPath,
    });
    expect(syncOpened.ok).toBe(false);
    if (syncOpened.ok) {
      fs.closeSync(syncOpened.fd);
    }

    const asyncOpened = await openRootFile({
      absolutePath: layout.outsideFile,
      boundaryLabel: "root",
      rootPath: layout.root,
      rootRealPath,
    });
    expect(asyncOpened.ok).toBe(false);
    if (asyncOpened.ok) {
      await asyncOpened.handle.close();
    }
  });

  it("rejects hardlinked read targets when hardlink rejection is enabled", async () => {
    const layout = await makeTempLayout("fs-safe-read-hardlink");
    const source = path.join(layout.root, "source.txt");
    const hardlink = path.join(layout.root, "hardlink.txt");
    await fsp.writeFile(source, "shared");
    await fsp.link(source, hardlink);
    const safeRoot = await openRoot(layout.root, { hardlinks: "reject" });

    await expect(safeRoot.read("hardlink.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["hardlink", "invalid-path"]);
      return true;
    });
    await expect(safeRoot.open("hardlink.txt")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["hardlink", "invalid-path"]);
      return true;
    });
  });

  it("rejects absolute read paths that traverse symlinks by default", async () => {
    const layout = await makeTempLayout("fs-safe-absolute-read");
    const linkPath = path.join(layout.root, "absolute-link.txt");
    await fsp.symlink(layout.outsideFile, linkPath, "file");

    await expect(resolveAbsolutePathForRead(linkPath)).rejects.toMatchObject({ code: "symlink" });
    const outsideFileReal = await fsp.realpath(layout.outsideFile);
    await expect(resolveAbsolutePathForRead(linkPath, { symlinks: "follow" })).resolves.toMatchObject({
      canonicalPath: outsideFileReal,
    });
  });

  it("keeps encoded traversal payloads literal instead of URL-decoding into an escape", async () => {
    const layout = await makeTempLayout("fs-safe-encoded-literal");
    await fsp.writeFile(path.join(layout.root, "%2e%2e%2fsecret.txt"), "literal");
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.readText("%2e%2e%2fsecret.txt")).resolves.toBe("literal");
    await expect(safeRoot.read("%2e%2e/secret.txt")).rejects.toBeTruthy();
  });

  it("rejects pathScope payload batches when any member escapes", async () => {
    const layout = await makeTempLayout("fs-safe-pathscope-payloads");
    const scope = pathScope(layout.root, { label: "test root" });

    for (const payload of TRAVERSAL_PAYLOADS) {
      await expect(scope.files(["safe.txt", payload]), `pathScope.files(${payload})`).resolves.toMatchObject({
        ok: false,
      });
    }
  });

  it("does not return outside bytes when root read APIs reject unsafe paths", async () => {
    const layout = await makeTempLayout("fs-safe-read-no-leak");
    await fsp.symlink(layout.outside, path.join(layout.root, "link"), "dir");
    const safeRoot = await openRoot(layout.root);

    for (const attempt of [
      () => safeRoot.read("../outside/secret.txt"),
      () => safeRoot.read("link/secret.txt"),
      () => safeRoot.open("link/secret.txt"),
    ]) {
      let opened: unknown;
      try {
        opened = await attempt();
        await closeIfOpen(opened);
        throw new Error("unsafe read unexpectedly succeeded");
      } catch (error) {
        await closeIfOpen(opened);
        expect(error).not.toMatchObject({ message: "unsafe read unexpectedly succeeded" });
      }
    }
  });
});
