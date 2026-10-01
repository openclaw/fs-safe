import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAbsolutePathForRead } from "../src/absolute-path.js";
import { root as openRoot } from "../src/index.js";
import { openPinnedFileSync } from "../src/pinned-open.js";
import { pathScope } from "../src/root-paths.js";
import { openRootFile, openRootFileSync } from "../src/root-file.js";
import {
  expectFsSafeCode,
  LIST_TRAVERSAL_PAYLOADS,
  makeTempLayout as makeSecurityTempLayout,
  TRAVERSAL_PAYLOADS,
} from "./helpers/security.js";
import { allowWindowsFilesystemStalls } from "./helpers/vitest.js";

allowWindowsFilesystemStalls();

const tempDirs: string[] = [];

async function makeTempLayout(prefix: string) {
  return await makeSecurityTempLayout(prefix, tempDirs);
}

type RootRejection = readonly [
  operation: "read" | "open" | "stat" | "list",
  pathname: string,
  codes: readonly string[],
  allowUnsupportedPlatformOnWindows: boolean,
];

async function expectRootRejections(safeRoot: Awaited<ReturnType<typeof openRoot>>, rows: readonly RootRejection[]) {
  for (const [operation, pathname, codes, allowUnsupportedPlatformOnWindows] of rows) {
    await expect(safeRoot[operation](pathname), `${operation}(${pathname})`).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, codes, { allowUnsupportedPlatformOnWindows });
      return true;
    });
  }
}

async function expectDirectRootRejections(rootPath: string, absolutePath: string) {
  const options = { absolutePath, boundaryLabel: "root", rootPath, rootRealPath: await fsp.realpath(rootPath) };
  const syncOpened = openRootFileSync(options);
  try {
    expect(syncOpened.ok).toBe(false);
  } finally {
    if (syncOpened.ok) fs.closeSync(syncOpened.fd);
  }
  const asyncOpened = await openRootFile(options);
  try {
    expect(asyncOpened.ok).toBe(false);
  } finally {
    if (asyncOpened.ok) await asyncOpened.handle.close();
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { force: true, recursive: true })));
});

describe("read boundary bypass attempts", () => {
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

  const traversalCodes = ["outside-workspace", "invalid-path", "path-alias"];
  it.each([
    {
      scenario: "across root read, open, stat, list, and path scope APIs",
      rows: [
        ["read", "../secret.txt", traversalCodes, false],
        ["open", "../secret.txt", traversalCodes, false],
        ["stat", "../secret.txt", traversalCodes, true],
        ["list", "..", traversalCodes, true],
      ],
      checkScope: true,
    },
    {
      scenario: "to ../outside/secret.txt without returning outside bytes",
      rows: [["read", "../outside/secret.txt", traversalCodes, false]],
      checkScope: false,
    },
  ] as const)("rejects traversal $scenario", async ({ rows, checkScope }) => {
    const layout = await makeTempLayout("fs-safe-read-traversal");
    const safeRoot = await openRoot(layout.root);
    await expectRootRejections(safeRoot, rows);
    if (checkScope) {
      const scope = pathScope(layout.root, { label: "test root" });
      await expect(scope.files(["../secret.txt"])).resolves.toMatchObject({ ok: false });
    }
  });

  it("rejects symlink parents across root read/open/stat/list APIs", async () => {
    const layout = await makeTempLayout("fs-safe-read-symlink-parent");
    await fsp.symlink(layout.outside, path.join(layout.root, "link"), "dir");
    const safeRoot = await openRoot(layout.root);

    const codes = ["outside-workspace", "path-alias", "symlink"];
    await expectRootRejections(safeRoot, [
      ["read", "link/secret.txt", codes, false],
      ["open", "link/secret.txt", codes, false],
      ["stat", "link/secret.txt", codes, true],
      ["list", "link", codes, true],
    ]);
  });

  it("rejects final symlink leaves for root read/open/stat and direct root-file APIs", async () => {
    const layout = await makeTempLayout("fs-safe-read-symlink-leaf");
    const linkPath = path.join(layout.root, "secret-link.txt");
    await fsp.symlink(layout.outsideFile, linkPath, "file");
    const safeRoot = await openRoot(layout.root);

    const codes = ["outside-workspace", "path-alias", "symlink"];
    await expectRootRejections(safeRoot, [
      ["read", "secret-link.txt", codes, false],
      ["open", "secret-link.txt", codes, false],
      ["stat", "secret-link.txt", codes, true],
    ]);
    await expectDirectRootRejections(layout.root, linkPath);

    const pinnedOpened = openPinnedFileSync({ filePath: linkPath, rejectPathSymlink: true });
    expect(pinnedOpened.ok).toBe(false);
    if (pinnedOpened.ok) {
      fs.closeSync(pinnedOpened.fd);
    }
  });

  it("rejects absolute outside files across root read, open, stat, and direct root-file APIs", async () => {
    const layout = await makeTempLayout("fs-safe-absolute-outside");
    const safeRoot = await openRoot(layout.root);
    const codes = ["outside-workspace", "path-alias", "invalid-path"];
    await expectRootRejections(safeRoot, [
      ["read", layout.outsideFile, codes, false],
      ["open", layout.outsideFile, codes, false],
      ["stat", layout.outsideFile, codes, true],
    ]);
    await expectDirectRootRejections(layout.root, layout.outsideFile);
  });

  it("rejects hardlinked read targets when hardlink rejection is enabled", async () => {
    const layout = await makeTempLayout("fs-safe-read-hardlink");
    const source = path.join(layout.root, "source.txt");
    const hardlink = path.join(layout.root, "hardlink.txt");
    await fsp.writeFile(source, "shared");
    await fsp.link(source, hardlink);
    const safeRoot = await openRoot(layout.root, { hardlinks: "reject" });

    const codes = ["hardlink", "invalid-path"];
    await expectRootRejections(safeRoot, [
      ["read", "hardlink.txt", codes, false],
      ["open", "hardlink.txt", codes, false],
    ]);
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
});
