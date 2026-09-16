import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type OpenRootFileParams = import("../src/root-file.js").OpenRootFileParams;

const resolveRootPathSyncMock = vi.hoisted(() => vi.fn());
const resolveRootPathMock = vi.hoisted(() => vi.fn());
const openPinnedFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("../src/root-path.js", () => ({
  resolveRootPathSyncWithCanonicalRootObservation: (
    params: unknown,
    observeRoot: (rootPath: string) => void,
  ) => {
    observeRoot("/real/root");
    return resolveRootPathSyncMock(params, observeRoot);
  },
  resolveRootPathWithCanonicalRootObservation: (
    params: unknown,
    observeRoot: (rootPath: string) => void,
  ) => {
    observeRoot("/real/root");
    return resolveRootPathMock(params, observeRoot);
  },
}));

vi.mock("../src/pinned-open.js", () => ({
  openPinnedFileSync: (...args: unknown[]) => openPinnedFileSyncMock(...args),
}));

vi.mock("../src/root-file-final-admission.js", () => ({
  observeCanonicalRoot: (_ioFs: unknown, rootPath: string) => ({
    ok: true,
    path: rootPath,
    identity: { dev: 1n, ino: 2n },
  }),
  createRootFileFinalAdmission: () => () => "/real/admitted",
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

    expect(resolveRootPathSyncMock).toHaveBeenCalledWith(
      {
        absolutePath,
        rootPath: "/workspace",
        rootCanonicalPath: undefined,
        boundaryLabel: "plugin root",
        rejectSymlinks: true,
        rejectFinalSymlink: false,
        skipLexicalRootCheck: undefined,
      },
      expect.any(Function),
    );
    expect(openPinnedFileSyncMock).toHaveBeenCalledWith({
      filePath: absolutePath,
      resolvedPath: "/real/plugin.json",
      rejectHardlinks: true,
      maxBytes: undefined,
      allowedType: undefined,
      ioFs,
      finalAdmission: expect.any(Function),
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

    expect(resolveRootPathMock).toHaveBeenCalledWith(
      {
        absolutePath,
        rootPath: "/workspace",
        rootCanonicalPath: undefined,
        boundaryLabel: "workspace",
        policy: {
          allowFinalSymlinkForUnlink: true,
          allowFinalHardlinkForUnlink: undefined,
        },
        rejectSymlinks: true,
        rejectFinalSymlink: false,
        skipLexicalRootCheck: undefined,
      },
      expect.any(Function),
    );
    expect(openPinnedFileSyncMock).toHaveBeenCalledWith({
      filePath: absolutePath,
      resolvedPath: "/real/notes.txt",
      rejectHardlinks: true,
      maxBytes: undefined,
      allowedType: undefined,
      ioFs,
      finalAdmission: expect.any(Function),
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

  it("snapshots every async option before boundary resolution yields", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    resolveRootPathMock.mockImplementation(async () => {
      await gate;
      return {
        canonicalPath: "/real/value",
        rootCanonicalPath: "/real/root",
      };
    });
    openPinnedFileSyncMock.mockReturnValue({
      ok: false,
      reason: "validation",
      error: new Error("finished"),
    });
    const aliasPolicy = {
      allowFinalSymlinkForUnlink: true,
      allowFinalHardlinkForUnlink: false,
    };
    const params: OpenRootFileParams = {
      absolutePath: "/input/value",
      rootPath: "/input/root",
      rootRealPath: "/real/root",
      boundaryLabel: "original boundary",
      aliasPolicy,
      rejectSymlinks: false,
      skipLexicalRootCheck: true,
      maxBytes: 99,
      rejectHardlinks: false,
      allowedType: "file",
    };

    const pending = openRootFile(params);
    params.rootPath = "/changed/root";
    params.rootRealPath = "/changed/real";
    params.boundaryLabel = "changed boundary";
    params.rejectSymlinks = true;
    params.skipLexicalRootCheck = false;
    params.maxBytes = 0;
    params.rejectHardlinks = true;
    params.allowedType = "directory";
    aliasPolicy.allowFinalSymlinkForUnlink = false;
    aliasPolicy.allowFinalHardlinkForUnlink = true;
    release();
    await pending;

    expect(resolveRootPathMock).toHaveBeenCalledWith(
      {
        absolutePath: "/input/value",
        rootPath: "/input/root",
        rootCanonicalPath: "/real/root",
        boundaryLabel: "original boundary",
        policy: {
          allowFinalSymlinkForUnlink: true,
          allowFinalHardlinkForUnlink: false,
        },
        rejectSymlinks: false,
        rejectFinalSymlink: false,
        skipLexicalRootCheck: true,
      },
      expect.any(Function),
    );
    expect(openPinnedFileSyncMock).toHaveBeenCalledWith(expect.objectContaining({
      rejectHardlinks: false,
      maxBytes: 99,
      allowedType: "file",
    }));
  });

  it("preserves async getter failure categories while snapshotting", async () => {
    const policyFailure = new Error("policy getter failed");
    const policyResult = await openRootFile({
      absolutePath: "/input/value",
      rootPath: "/input/root",
      boundaryLabel: "fixture",
      get aliasPolicy() {
        throw policyFailure;
      },
    });
    expect(policyResult).toEqual({
      ok: false,
      reason: "validation",
      error: policyFailure,
    });

    const openFailure = new Error("open getter failed");
    await expect(openRootFile({
      absolutePath: "/input/value",
      rootPath: "/input/root",
      boundaryLabel: "fixture",
      get maxBytes(): number {
        throw openFailure;
      },
    })).rejects.toBe(openFailure);
  });

  it("reads async option getters once and shallow-snapshots alias policy", async () => {
    resolveRootPathMock.mockResolvedValue({
      canonicalPath: "/real/value",
      rootCanonicalPath: "/real/root",
    });
    openPinnedFileSyncMock.mockReturnValue({
      ok: false,
      reason: "validation",
      error: new Error("finished"),
    });
    const reads = new Map<PropertyKey, number>();
    const aliasReads = new Map<PropertyKey, number>();
    const aliasPolicy = new Proxy({
      allowFinalSymlinkForUnlink: false,
      allowFinalHardlinkForUnlink: false,
    }, {
      get(target, property, receiver) {
        aliasReads.set(property, (aliasReads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      },
    });
    const values: OpenRootFileParams = {
      absolutePath: "/input/value",
      rootPath: "/input/root",
      rootRealPath: "/real/root",
      boundaryLabel: "fixture",
      aliasPolicy,
      rejectSymlinks: false,
      symlinks: undefined,
      skipLexicalRootCheck: true,
      maxBytes: 9,
      rejectHardlinks: false,
      allowedType: "file",
    };
    const params = new Proxy(values, {
      get(target, property, receiver) {
        reads.set(property, (reads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      },
    });

    await openRootFile(params);

    for (const property of [
      "absolutePath",
      "rootPath",
      "rootRealPath",
      "boundaryLabel",
      "aliasPolicy",
      "rejectSymlinks",
      "symlinks",
      "skipLexicalRootCheck",
      "maxBytes",
      "rejectHardlinks",
      "allowedType",
    ]) {
      expect(reads.get(property)).toBe(1);
    }
    expect(aliasReads.get("allowFinalSymlinkForUnlink")).toBe(1);
    expect(aliasReads.get("allowFinalHardlinkForUnlink")).toBe(1);
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
