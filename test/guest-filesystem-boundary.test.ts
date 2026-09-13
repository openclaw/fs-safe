import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe.skipIf(process.platform === "win32")("guest filesystem boundaries", () => {
  it.each(["write", "create", "remove"])("rejects a traversal basename on the real filesystem during %s", async (operation) => {
    const directory = await tempRoot("fs-safe-guest-basename-traversal-");
    const root = path.join(directory, "root");
    const outside = path.join(directory, "outside");
    await fs.mkdir(root);
    await fs.writeFile(outside, "preserve");
    const args = operation === "remove"
      ? [operation, root, "", "../outside", "0", "1"]
      : [operation, root, "created", "../outside", "1"];

    const result = runGuest(args, "replacement");

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("invalid basename");
    expect(await fs.readFile(outside, "utf8")).toBe("preserve");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["write", "create", "mkdirp", "copy", "rename"])("rejects symlink parents during %s", async (operation) => {
    const directory = await tempRoot("fs-safe-guest-parent-");
    const root = path.join(directory, "root");
    const outside = path.join(directory, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, "source"), "original");
    await fs.symlink(outside, path.join(root, "alias"));
    const args = operation === "mkdirp"
      ? [operation, root, "alias/created"]
      : operation === "copy" || operation === "rename"
        ? [operation, root, "", "source", root, "alias", "created", "1"]
        : [operation, root, "alias", "created", "1"];
    const result = runGuest(args, "payload");
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("original");
  });

  it("rejects relative parent traversal before creating directories", async () => {
    const root = await tempRoot("fs-safe-guest-parent-traversal-");
    const result = runGuest(["write", root, "created/../outside", "value", "1"], "payload");
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("path traversal is not allowed");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["0", "1"])("unlinks leaf symlinks without following them, recursive=%s", async (recursive) => {
    const directory = await tempRoot("fs-safe-guest-unlink-");
    const root = path.join(directory, "root");
    const outside = path.join(directory, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep"), "outside");
    await fs.symlink(outside, path.join(root, "link"));
    const listed = runGuest(["readdir", root, ""]);
    expect(listed.error).toBeUndefined();
    expect(listed.status, listed.stderr.toString()).toBe(0);
    expect(JSON.parse(listed.stdout.toString())).toEqual([{ name: "link", isDirectory: false }]);

    const removed = runGuest(["remove", root, "", "link", recursive, "0"]);
    expect(removed.error).toBeUndefined();
    expect(removed.status, removed.stderr.toString()).toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("outside");
  });

  it.each(["read", "copy"])("rejects hardlinked %s inputs without touching their target", async (operation) => {
    const root = await tempRoot("fs-safe-guest-hardlink-");
    await fs.writeFile(path.join(root, "original"), "original");
    await fs.link(path.join(root, "original"), path.join(root, "alias"));
    const args = operation === "read" ? [operation, root, "", "alias"] : [operation, root, "", "alias", root, "", "copy", "0"];
    const result = runGuest(args);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("hardlinked file is not allowed");
    expect(result.stdout).toHaveLength(0);
    expect((await fs.readdir(root)).sort()).toEqual(["alias", "original"]);
    expect(await fs.readFile(path.join(root, "original"), "utf8")).toBe("original");
  });

  it.each(["symlink", "directory", "fifo"])("rejects %s reads without waiting for data", async (kind) => {
    const root = await tempRoot("fs-safe-guest-read-type-");
    const target = path.join(root, "value");
    if (kind === "symlink") {
      await fs.writeFile(path.join(root, "original"), "original");
      await fs.symlink("original", target);
    } else if (kind === "directory") {
      await fs.mkdir(target);
    }
    const setup = kind === "fifo" ? "os.mkfifo(os.path.join(sys.argv[2], sys.argv[4]))" : undefined;
    const result = runGuest(["read", root, "", "value"], undefined, setup);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toHaveLength(0);
    if (kind !== "symlink") expect(result.stderr.toString()).toContain("only regular files are allowed");
  });
});
