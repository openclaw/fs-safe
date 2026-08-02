import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileStore } from "../src/file-store.js";
import { isWindowsNetworkPath } from "../src/local-file-access.js";
import {
  isPathInside,
  normalizeWindowsPathForComparison,
  splitSafeRelativePath,
} from "../src/path.js";
import { root as openRoot } from "../src/root.js";
import { isDriveRelativePath } from "../src/safe-path-segment.js";

describe("Windows path classification", () => {
  it("distinguishes extended local paths from UNC paths", () => {
    expect(isWindowsNetworkPath("\\\\server\\share\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\UNC\\server\\share\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\C:\\secrets\\token", "win32")).toBe(false);
    expect(
      isWindowsNetworkPath("\\\\?\\GLOBALROOT\\Device\\Mup\\server\\share\\token", "win32"),
    ).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\Volume{abc}\\secrets\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\.\\pipe\\service", "win32")).toBe(true);
  });
});

describe("Windows comparison normalization", () => {
  it("keeps surrounding whitespace so padded paths stay distinct", () => {
    expect(normalizeWindowsPathForComparison("C:\\root ")).toBe("c:\\root ");
    expect(normalizeWindowsPathForComparison("C:\\root\u00a0")).toBe(
      "c:\\root\u00a0",
    );
  });

  it("still lowercases, normalizes separators, and strips the extended-length prefix", () => {
    expect(normalizeWindowsPathForComparison("\\\\?\\UNC\\Server\\Share\\A/../B")).toContain(
      "\\\\server\\share",
    );
    expect(normalizeWindowsPathForComparison("\\\\?\\C:\\Users/Public")).toBe(
      "c:\\users\\public",
    );
  });
});

describe("drive-relative relative paths", () => {
  const aliasingInputs = [
    "C:evil",
    "c:evil",
    "C:",
    "C:..",
    "C:evil/sub",
    "a/C:b",
    "./C:evil",
    "a/D:b",
  ];

  it("rejects drive-letter segments that Windows would resolve away", () => {
    for (const input of aliasingInputs) {
      expect(() => splitSafeRelativePath(input)).toThrow("drive letter");
    }
  });

  it("separates drive-relative spellings from drive-absolute ones", () => {
    for (const value of ["C:evil", "c:", "Z:.."]) {
      expect(isDriveRelativePath(value), value).toBe(true);
    }
    for (const value of ["C:\\root\\file.txt", "C:/root/file.txt", "notes/c:file"]) {
      expect(isDriveRelativePath(value), value).toBe(false);
    }
  });

  it("keeps accepting ordinary segments that merely contain a colon", () => {
    expect(splitSafeRelativePath("logs/2026-08-02T10:30:00Z.log")).toEqual([
      "logs",
      "2026-08-02T10:30:00Z.log",
    ]);
  });

  it("rejects drive-relative Root destinations without rejecting existing-object sources", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-drive-relative-root-"));
    try {
      const root = await openRoot(rootDir);
      await root.write("source.txt", "source");
      const destination = "C:destination.txt";

      const calls: Array<[string, () => Promise<unknown>]> = [
        ["root.resolve", () => root.resolve(destination)],
        ["root.openWritable", () => root.openWritable(destination)],
        ["root.append", () => root.append(destination, "aliased")],
        ["root.mkdir", () => root.mkdir(destination)],
        ["root.write", () => root.write(destination, "aliased")],
        ["root.create", () => root.create(destination, "aliased")],
        ["root.copyIn", () => root.copyIn(destination, path.join(rootDir, "source.txt"))],
        ["root.move destination", () => root.move("source.txt", destination)],
      ];
      for (const [label, call] of calls) {
        await expect(call(), label).rejects.toMatchObject({ code: "invalid-path" });
      }

      await expect(readFile(path.join(rootDir, "source.txt"), "utf8")).resolves.toBe("source");
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "reads and inspects POSIX-legal drive-like filenames",
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-drive-like-existing-"));
      try {
        await writeFile(path.join(rootDir, "c:notes.txt"), "notes");
        await writeFile(path.join(rootDir, "c:move.txt"), "move");
        await writeFile(path.join(rootDir, "c:remove.txt"), "remove");
        await mkdir(path.join(rootDir, "c:folder"));
        await writeFile(path.join(rootDir, "c:folder", "entry.txt"), "entry");
        const root = await openRoot(rootDir);

        const opened = await root.open("c:notes.txt");
        await opened.handle.close();
        await expect(root.readText("c:notes.txt")).resolves.toBe("notes");
        await expect(root.readAbsolute("c:notes.txt")).resolves.toMatchObject({
          buffer: Buffer.from("notes"),
        });
        await expect(root.reader()("c:notes.txt")).resolves.toEqual(Buffer.from("notes"));
        await expect(root.stat("c:notes.txt")).resolves.toMatchObject({ isFile: true });
        await expect(root.exists("c:notes.txt")).resolves.toBe(true);
        await expect(root.list("c:folder")).resolves.toEqual(["entry.txt"]);

        const walked: string[] = [];
        for await (const entry of root.walk("c:folder", { symlinkPolicy: "skip" })) {
          walked.push(entry.relativePath);
        }
        expect(walked).toEqual(["c:folder/entry.txt"]);

        await root.move("c:move.txt", "moved.txt");
        await expect(readFile(path.join(rootDir, "moved.txt"), "utf8")).resolves.toBe("move");
        await root.remove("c:remove.txt");
        await expect(root.exists("c:remove.txt")).resolves.toBe(false);
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it("rejects drive-relative spellings on every FileStore key path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-drive-relative-store-"));
    try {
      const store = fileStore({ rootDir });
      await store.writeText("source.txt", "source");
      for (const input of aliasingInputs) {
        expect(() => store.path(input), input).toThrow("drive letter");
      }
      expect(store.path("logs/2026-08-02T10:30:00Z.log")).toBe(
        path.join(rootDir, "logs", "2026-08-02T10:30:00Z.log"),
      );

      const key = "C:source.txt";
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["store.open", () => store.open(key)],
        ["store.readText", () => store.readText(key)],
        ["store.exists", () => store.exists(key)],
        ["store.remove", () => store.remove(key)],
        ["store.writeText", () => store.writeText(key, "aliased")],
        ["store.copyIn", () => store.copyIn(key, path.join(rootDir, "source.txt"))],
      ];
      for (const [label, call] of calls) {
        await expect(call(), label).rejects.toMatchObject({ code: "invalid-path" });
      }
      expect(() => store.json(key)).toThrow("drive letter");
      await expect(readFile(path.join(rootDir, "source.txt"), "utf8")).resolves.toBe("source");
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("keeps accepting an absolute path that stays inside the root", async () => {
    // The temp dir must be resolved: macOS hands back /var/... for a /private/var/...
    // root and Windows CI hands back an 8.3 short name, either of which reads as
    // outside the root once openRoot() resolves it.
    const rootDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "fs-safe-drive-relative-absolute-")),
    );
    try {
      const root = await openRoot(rootDir);
      await root.write("note.txt", "kept");

      await expect(root.readText(path.join(rootDir, "note.txt"))).resolves.toBe("kept");
      await expect(
        root.readAbsolute(path.join(rootDir, "note.txt")),
      ).resolves.toMatchObject({ buffer: Buffer.from("kept") });
      await expect(root.reader()(path.join(rootDir, "note.txt"))).resolves.toEqual(
        Buffer.from("kept"),
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("stops a drive-relative store key from aliasing a plain key", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-drive-relative-"));
    try {
      const store = fileStore({ rootDir });
      await store.writeText("secret.txt", "real");

      await expect(store.writeText("C:secret.txt", "aliased")).rejects.toMatchObject({
        code: "invalid-path",
      });
      await expect(readFile(path.join(rootDir, "secret.txt"), "utf8")).resolves.toBe("real");
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});

describe.skipIf(process.platform !== "win32")("Windows containment with padded roots", () => {
  it("does not report a sibling directory as inside a space-padded root", () => {
    expect(isPathInside("C:\\root ", "C:\\root\\secret.txt")).toBe(false);
  });

  it("still reports genuine descendants as inside", () => {
    expect(isPathInside("C:\\root", "C:\\root\\secret.txt")).toBe(true);
  });
});
