import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveRootPathSyncMock = vi.hoisted(() => vi.fn());
const resolveRootPathMock = vi.hoisted(() => vi.fn());
const openPinnedFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("../src/root-path.js", () => ({
  resolveRootPathSync: (...args: unknown[]) => resolveRootPathSyncMock(...args),
  resolveRootPath: (...args: unknown[]) => resolveRootPathMock(...args),
}));

vi.mock("../src/pinned-open.js", () => ({
  openPinnedFileSync: (...args: unknown[]) => openPinnedFileSyncMock(...args),
}));

let canUseRootFileOpen: typeof import("../src/root-file.js").canUseRootFileOpen;
let matchRootFileOpenFailure: typeof import("../src/root-file.js").matchRootFileOpenFailure;
let openRootFile: typeof import("../src/root-file.js").openRootFile;
let openRootFileSync: typeof import("../src/root-file.js").openRootFileSync;

describe("root-file", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({
      canUseRootFileOpen,
      matchRootFileOpenFailure,
      openRootFile,
      openRootFileSync,
    } = await import("../src/root-file.js"));
    resolveRootPathSyncMock.mockReset();
    resolveRootPathMock.mockReset();
    openPinnedFileSyncMock.mockReset();
  });

  it("recognizes the required sync fs surface", () => {
    const validFs = {
      openSync() {},
      closeSync() {},
      fstatSync() {},
      lstatSync() {},
      realpathSync() {},
      readFileSync() {},
      constants: {},
    };

    expect(canUseRootFileOpen(validFs as never)).toBe(true);
    expect(
      canUseRootFileOpen({
        ...validFs,
        openSync: undefined,
      } as never),
    ).toBe(false);
    expect(
      canUseRootFileOpen({
        ...validFs,
        constants: null,
      } as never),
    ).toBe(false);
  });

  it("maps sync boundary resolution into verified file opens", () => {
    const stat = { size: 3 } as never;
    const ioFs = { marker: "io" } as never;
    const absolutePath = path.resolve("plugin.json");

    resolveRootPathSyncMock.mockReturnValue({
      canonicalPath: "/real/plugin.json",
      rootCanonicalPath: "/real/root",
    });
    openPinnedFileSyncMock.mockReturnValue({
      ok: true,
      path: "/real/plugin.json",
      fd: 7,
      stat,
    });

    const opened = openRootFileSync({
      absolutePath: "plugin.json",
      rootPath: "/workspace",
      boundaryLabel: "plugin root",
      ioFs,
    });

    expect(resolveRootPathSyncMock).toHaveBeenCalledWith({
      absolutePath,
      rootPath: "/workspace",
      rootCanonicalPath: undefined,
      boundaryLabel: "plugin root",
      rejectSymlinks: true,
      skipLexicalRootCheck: undefined,
    });
    expect(openPinnedFileSyncMock).toHaveBeenCalledWith({
      filePath: absolutePath,
      resolvedPath: "/real/plugin.json",
      rejectHardlinks: true,
      maxBytes: undefined,
      allowedType: undefined,
      ioFs,
    });
    expect(opened).toEqual({
      ok: true,
      path: "/real/plugin.json",
      fd: 7,
      stat,
      rootRealPath: "/real/root",
    });
  });

  it("returns validation errors when sync boundary resolution throws", () => {
    const error = new Error("outside root");
    resolveRootPathSyncMock.mockImplementation(() => {
      throw error;
    });

    const opened = openRootFileSync({
      absolutePath: "plugin.json",
      rootPath: "/workspace",
      boundaryLabel: "plugin root",
    });

    expect(opened).toEqual({
      ok: false,
      reason: "validation",
      error,
    });
    expect(openPinnedFileSyncMock).not.toHaveBeenCalled();
  });

  it("guards against unexpected async sync-resolution results", () => {
    resolveRootPathSyncMock.mockReturnValue(
      Promise.resolve({
        canonicalPath: "/real/plugin.json",
        rootCanonicalPath: "/real/root",
      }),
    );

    const opened = openRootFileSync({
      absolutePath: "plugin.json",
      rootPath: "/workspace",
      boundaryLabel: "plugin root",
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) {
      return;
    }
    expect(opened.reason).toBe("validation");
    expect(String(opened.error)).toContain("Unexpected async boundary resolution");
  });

  it("awaits async boundary resolution before verifying the file", async () => {
    const ioFs = { marker: "io" } as never;
    const absolutePath = path.resolve("notes.txt");

    resolveRootPathMock.mockResolvedValue({
      canonicalPath: "/real/notes.txt",
      rootCanonicalPath: "/real/root",
    });
    openPinnedFileSyncMock.mockReturnValue({
      ok: false,
      reason: "validation",
      error: new Error("blocked"),
    });

    const opened = await openRootFile({
      absolutePath: "notes.txt",
      rootPath: "/workspace",
      boundaryLabel: "workspace",
      aliasPolicy: { allowFinalSymlinkForUnlink: true },
      ioFs,
    });

    expect(resolveRootPathMock).toHaveBeenCalledWith({
      absolutePath,
      rootPath: "/workspace",
      rootCanonicalPath: undefined,
      boundaryLabel: "workspace",
      policy: { allowFinalSymlinkForUnlink: true },
      rejectSymlinks: true,
      skipLexicalRootCheck: undefined,
    });
    expect(openPinnedFileSyncMock).toHaveBeenCalledWith({
      filePath: absolutePath,
      resolvedPath: "/real/notes.txt",
      rejectHardlinks: true,
      maxBytes: undefined,
      allowedType: undefined,
      ioFs,
    });
    expect(opened).toEqual({
      ok: false,
      reason: "validation",
      error: expect.any(Error),
    });
  });

  it("maps async boundary resolution failures to validation errors", async () => {
    const error = new Error("escaped");
    resolveRootPathMock.mockRejectedValue(error);

    const opened = await openRootFile({
      absolutePath: "notes.txt",
      rootPath: "/workspace",
      boundaryLabel: "workspace",
    });

    expect(opened).toEqual({
      ok: false,
      reason: "validation",
      error,
    });
    expect(openPinnedFileSyncMock).not.toHaveBeenCalled();
  });

  it("matches boundary file failures by reason with fallback support", () => {
    const missing = matchRootFileOpenFailure(
      { ok: false, reason: "path", error: new Error("missing") },
      {
        path: () => "missing",
        fallback: () => "fallback",
      },
    );
    const io = matchRootFileOpenFailure(
      { ok: false, reason: "io", error: new Error("io") },
      {
        io: () => "io",
        fallback: () => "fallback",
      },
    );
    const validation = matchRootFileOpenFailure(
      { ok: false, reason: "validation", error: new Error("blocked") },
      {
        fallback: (failure) => failure.reason,
      },
    );

    expect(missing).toBe("missing");
    expect(io).toBe("io");
    expect(validation).toBe("validation");
  });
});
