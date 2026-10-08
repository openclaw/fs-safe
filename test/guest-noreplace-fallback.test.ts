import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_FILESYSTEM_RENAME_NO_REPLACE_PYTHON } from "../src/guest.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

// Inject only the unavailable syscall; all descriptor-relative filesystem work is real.
function publish(root: string, setup = "", failure = "EINVAL", onReject = "pass") {
  return spawnSync("python3", ["-c", [
    "import ctypes, errno, json, os, sys",
    "sys.platform = 'linux'",
    "sys.excepthook = lambda kind, error, trace: print(json.dumps({'errno': getattr(error, 'errno', None), 'message': str(error)}), file=sys.stderr)",
    "parent = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)",
    "class UnsupportedRename:",
    "    def __call__(self, *args):",
    "        assert args[4] == 1",
    `        ${onReject}`,
    `        ctypes.set_errno(errno.${failure})`,
    "        return -1",
    "class Libc:",
    "    renameat2 = UnsupportedRename()",
    "ctypes.CDLL = lambda *args, **kwargs: Libc()",
    GUEST_FILESYSTEM_RENAME_NO_REPLACE_PYTHON,
    setup,
    "rename_no_replace(parent, 'source', parent, 'target')",
    "os.close(parent)",
  ].join("\n"), root], { encoding: "utf8", timeout: 5_000 });
}

describe.skipIf(process.platform === "win32")("guest no-replace fallback", () => {
  it.each(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"])("publishes a complete directory after %s", async failure => {
    const root = await tempRoot("fs-safe-guest-directory-");
    await fs.mkdir(path.join(root, "source"));
    await fs.writeFile(path.join(root, "source", "payload"), "complete");
    const before = await fs.lstat(path.join(root, "source"));
    const result = publish(root, "", failure);
    expect(result.status, result.stderr).toBe(0);
    expect(await fs.lstat(path.join(root, "target"))).toMatchObject({ dev: before.dev, ino: before.ino });
    expect(await fs.readFile(path.join(root, "target", "payload"), "utf8")).toBe("complete");
    expect(await fs.readdir(root)).toEqual(["target"]);
  });

  it("consumes a file source only after verifying the two-link pair", async () => {
    const root = await tempRoot("fs-safe-guest-file-");
    await fs.writeFile(path.join(root, "source"), "payload");
    const before = await fs.lstat(path.join(root, "source"));
    const result = publish(root);
    expect(result.status, result.stderr).toBe(0);
    expect(await fs.lstat(path.join(root, "target"))).toMatchObject({ dev: before.dev, ino: before.ino, nlink: 1 });
    expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe("payload");
    expect(await fs.readdir(root)).toEqual(["target"]);
  });

  it("publishes a directory when libc has no renameat2", async () => {
    const root = await tempRoot("fs-safe-guest-missing-rename-");
    await fs.mkdir(path.join(root, "source"));
    const result = publish(root, "del Libc.renameat2");
    expect(result.status, result.stderr).toBe(0);
    expect(await fs.readdir(root)).toEqual(["target"]);
  });

  it.each(["EACCES", "EIO", "EXDEV"])("does not fall back for directory error %s", async failure => {
    const root = await tempRoot("fs-safe-guest-rename-denied-");
    await fs.mkdir(path.join(root, "source"));
    const result = publish(root, "", failure);
    expect(result.status).toBe(1);
    expect(await fs.readdir(root)).toEqual(["source"]);
  });

  it("refuses a file already hardlinked at admission", async () => {
    const root = await tempRoot("fs-safe-guest-existing-link-");
    await fs.writeFile(path.join(root, "source"), "original");
    await fs.link(path.join(root, "source"), path.join(root, "third"));
    const result = publish(root);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).message).toContain("link count changed");
    expect(await fs.readdir(root)).toEqual(["source", "third"]);
  });

  it.each(["file", "directory", "empty", "symlink"])("refuses a %s target created before the fallback", async kind => {
    const root = await tempRoot("fs-safe-guest-collision-");
    await fs.mkdir(path.join(root, "source"));
    const create = kind === "file" ? "open('target', 'w').write('winner')"
      : kind === "symlink" ? "os.symlink('missing', 'target')"
      : `os.mkdir('target')${kind === "directory" ? "; open('target/winner', 'w').write('winner')" : ""}`;
    const result = publish(root, "os.chdir(sys.argv[1])", "EINVAL", create);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).errno).toBe(17); // EEXIST
    expect(await fs.readdir(root)).toEqual(["source", "target"]);
    if (kind === "file") expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe("winner");
    if (kind === "directory") expect(await fs.readFile(path.join(root, "target", "winner"), "utf8")).toBe("winner");
    if (kind === "symlink") expect(await fs.readlink(path.join(root, "target"))).toBe("missing");
  });

  it.each(["file", "directory", "empty"])("bounds a %s collision at the plain rename syscall", async kind => {
    const root = await tempRoot("fs-safe-guest-rename-race-");
    await fs.mkdir(path.join(root, "source"));
    await fs.writeFile(path.join(root, "source", "payload"), "complete");
    const result = publish(root, [
      "original_rename = os.rename",
      "def race(src, dst, **kwargs):",
      "    assert src == 'source/'",
      "    assert kwargs == {'src_dir_fd': parent, 'dst_dir_fd': parent}",
      ...(kind === "file" ? ["    open(os.path.join(sys.argv[1], 'target'), 'w').write('winner')"] : [
        "    os.mkdir('target', dir_fd=parent)",
        ...(kind === "directory" ? ["    open(os.path.join(sys.argv[1], 'target/winner'), 'w').write('winner')"] : []),
      ]),
      "    return original_rename(src, dst, **kwargs)",
      "os.rename = race",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(kind === "empty" ? 0 : 1);
    if (kind === "empty") {
      expect(await fs.readFile(path.join(root, "target", "payload"), "utf8")).toBe("complete");
      expect(await fs.readdir(root)).toEqual(["target"]);
    } else {
      expect(JSON.parse(result.stderr).errno).toBe(17);
      expect(await fs.readFile(path.join(root, "source", "payload"), "utf8")).toBe("complete");
      expect(await fs.readFile(path.join(root, "target", ...(kind === "directory" ? ["winner"] : [])), "utf8")).toBe("winner");
    }
  });

  it.each(["file", "directory"])("refuses a %s source replaced during rejection", async kind => {
    const root = await tempRoot("fs-safe-guest-source-race-");
    if (kind === "directory") await fs.mkdir(path.join(root, "source"));
    else await fs.writeFile(path.join(root, "source"), "original");
    const result = publish(root, "os.chdir(sys.argv[1])", "EINVAL",
      "os.rename('source', 'saved'); open('source', 'w').write('replacement')");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).message).toContain("changed");
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("replacement");
    expect(await fs.readdir(root)).toEqual(["saved", "source"]);
  });

  it.each(["file", "symlink"])("cannot clobber a file after directory source substitution with a %s", async kind => {
    const root = await tempRoot("fs-safe-guest-type-race-");
    await fs.mkdir(path.join(root, "source"));
    const result = publish(root, [
      "os.chdir(sys.argv[1])",
      "original_rename = os.rename",
      "def race(src, dst, **kwargs):",
      "    original_rename('source', 'saved')",
      "    open('target', 'w').write('winner')",
      kind === "file" ? "    open('source', 'w').write('replacement')" : "    os.symlink('target', 'source')",
      "    return original_rename(src, dst, **kwargs)",
      "os.rename = race",
    ].join("\n"));
    expect(result.status).toBe(1);
    expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe("winner");
    expect(await fs.readdir(root)).toEqual(["saved", "source", "target"]);
  });

  it.each(["source", "target", "third-link"])("preserves the source on post-link %s interference", async fault => {
    const root = await tempRoot("fs-safe-guest-link-race-");
    await fs.writeFile(path.join(root, "source"), "original");
    const result = publish(root, [
      "os.chdir(sys.argv[1])",
      "original_link = os.link",
      "def race(*args, **kwargs):",
      "    original_link(*args, **kwargs)",
      ...(fault === "third-link" ? ["    original_link('source', 'third')"] : [
        `    os.rename('${fault}', 'saved')`,
        `    open('${fault}', 'w').write('replacement')`,
      ]),
      "os.link = race",
    ].join("\n"));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).message).toContain("changed");
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe(fault === "source" ? "replacement" : "original");
    expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe(fault === "target" ? "replacement" : "original");
  });
});
