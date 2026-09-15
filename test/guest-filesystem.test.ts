import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_FILESYSTEM_READ_NOT_FOUND_EXIT_CODE } from "../src/guest.js";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

const PARENT_CREATION_OPERATIONS = ["write", "create", "copy", "rename", "mkdirp"] as const;

function parentCreationArgs(
  operation: (typeof PARENT_CREATION_OPERATIONS)[number],
  workspace: string,
  mkdir = "1",
): string[] {
  if (operation === "mkdirp") return [operation, workspace, "raced/nested"];
  if (operation === "copy" || operation === "rename") {
    return [operation, workspace, "", "source.txt", workspace, "raced/nested", "note.txt", mkdir];
  }
  return [operation, workspace, "raced/nested", "note.txt", mkdir];
}

function competingParentSetup(kind: "directory" | "symlink" | "file"): string {
  const create = kind === "directory"
    ? ["os.mkdir('raced', 0o777, dir_fd=parent_fd)"]
    : kind === "symlink"
      ? ["os.symlink('../outside', 'raced', dir_fd=parent_fd)"]
      : [
          "competitor_fd = original_open('raced', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_fd)",
          "try:",
          "    os.write(competitor_fd, b'competitor')",
          "finally:",
          "    os.close(competitor_fd)",
        ];
  // Inject after the actual missing-directory observation, without rewriting the guest source.
  return [
    "original_open = os.open",
    "competing_parent_created = False",
    "def open_with_competing_parent(*args, **kwargs):",
    "    global competing_parent_created",
    "    try:",
    "        return original_open(*args, **kwargs)",
    "    except FileNotFoundError:",
    "        if not competing_parent_created and args[0] == 'raced' and kwargs.get('dir_fd') is not None:",
    "            competing_parent_created = True",
    "            parent_fd = kwargs['dir_fd']",
    ...create.map((line) => `            ${line}`),
    "            sys.stderr.write('competing parent created\\n')",
    "        raise",
    "os.open = open_with_competing_parent",
  ].join("\n");
}

describe.skipIf(process.platform === "win32")("guest parent creation races", () => {
  it.each(PARENT_CREATION_OPERATIONS)(
    "%s accepts a directory created after the missing-parent observation",
    async (operation) => {
      const workspace = await tempRoot("fs-safe-guest-parent-race-");
      await fs.writeFile(path.join(workspace, "source.txt"), "payload");

      const result = runGuest(
        parentCreationArgs(operation, workspace),
        operation === "write" || operation === "create" ? "payload" : undefined,
        competingParentSetup("directory"),
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toContain("competing parent created");
      const nested = path.join(workspace, "raced", "nested");
      expect(await fs.readdir(nested)).toEqual(operation === "mkdirp" ? [] : ["note.txt"]);
      if (operation !== "mkdirp") {
        expect(await fs.readFile(path.join(nested, "note.txt"), "utf8")).toBe("payload");
      }
      if (operation === "rename") {
        await expect(fs.lstat(path.join(workspace, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fs.readFile(path.join(workspace, "source.txt"), "utf8")).toBe("payload");
      }
    },
  );

  it.each(PARENT_CREATION_OPERATIONS.flatMap((operation) =>
    (["symlink", "file"] as const).map((kind) => ({ operation, kind })),
  ))("$operation rejects a competing $kind before writing payload", async ({ operation, kind }) => {
    const root = await tempRoot("fs-safe-guest-parent-race-");
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(workspace, "source.txt"), "payload");
    await fs.writeFile(path.join(outside, "keep.txt"), "unchanged");

    const result = runGuest(
      parentCreationArgs(operation, workspace),
      undefined,
      competingParentSetup(kind),
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("competing parent created");
    expect(result.stderr.toString()).toMatch(/NotADirectoryError|Not a directory|Too many levels/i);
    expect((await fs.readdir(workspace)).sort()).toEqual(["raced", "source.txt"]);
    expect(await fs.readFile(path.join(workspace, "source.txt"), "utf8")).toBe("payload");
    expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("unchanged");
    if (kind === "file") {
      expect(await fs.readFile(path.join(workspace, "raced"), "utf8")).toBe("competitor");
    } else {
      expect(await fs.readlink(path.join(workspace, "raced"))).toBe("../outside");
    }
  });

  it.each(["write", "create", "copy", "rename"] as const)(
    "%s still rejects a missing parent when mkdir is disabled",
    async (operation) => {
      const workspace = await tempRoot("fs-safe-guest-no-mkdir-");
      await fs.writeFile(path.join(workspace, "source.txt"), "payload");
      const result = runGuest(parentCreationArgs(operation, workspace, "0"));

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr.toString()).toContain("FileNotFoundError");
      expect(await fs.readdir(workspace)).toEqual(["source.txt"]);
      expect(await fs.readFile(path.join(workspace, "source.txt"), "utf8")).toBe("payload");
    },
  );

  it.each(["missing", "file", "symlink", "directory"] as const)(
    "admits only a directory when the competing parent becomes %s before the final open",
    async (kind) => {
      const root = await tempRoot("fs-safe-guest-parent-change-");
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await fs.mkdir(workspace);
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "keep.txt"), "unchanged");
      const replacement = kind === "directory"
        ? ["original_mkdir(name, 0o777, dir_fd=parent_fd)"]
        : kind === "symlink"
          ? ["os.symlink('../outside', name, dir_fd=parent_fd)"]
          : kind === "file"
            ? [
                "replacement_fd = original_open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_fd)",
                "os.close(replacement_fd)",
              ]
            : [];
      const setup = [
        competingParentSetup("directory"),
        "original_mkdir = os.mkdir",
        "def mkdir_then_change_competitor(name, *args, **kwargs):",
        "    try:",
        "        return original_mkdir(name, *args, **kwargs)",
        "    except FileExistsError:",
        "        if name == 'raced':",
        "            parent_fd = kwargs['dir_fd']",
        "            os.rmdir(name, dir_fd=parent_fd)",
        ...replacement.map((line) => `            ${line}`),
        "            sys.stderr.write('competing parent changed\\n')",
        "        raise",
        "os.mkdir = mkdir_then_change_competitor",
      ].join("\n");
      const result = runGuest(parentCreationArgs("write", workspace),
        kind === "directory" ? "payload" : undefined, setup);

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.stderr.toString().match(/competing parent created/g)).toHaveLength(1);
      expect(result.stderr.toString()).toContain("competing parent changed");
      expect(result.status).toBe(kind === "directory" ? 0 : 1);
      expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
      expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("unchanged");
      if (kind === "directory") {
        // Admission accepts the current directory, not ownership of the mkdir winner.
        expect(await fs.readFile(path.join(workspace, "raced/nested/note.txt"), "utf8"))
          .toBe("payload");
        expect(await fs.readdir(path.join(workspace, "raced/nested"))).toEqual(["note.txt"]);
      } else if (kind === "missing") {
        expect(result.stderr.toString().trimEnd().split("\n").at(-1)).toMatch(/^FileNotFoundError:/);
        expect(await fs.readdir(workspace)).toEqual([]);
      } else {
        expect(result.stderr.toString().trimEnd().split("\n").at(-1))
          .toMatch(/NotADirectoryError|Not a directory|Too many levels/i);
        expect(await fs.readdir(workspace)).toEqual(["raced"]);
        if (kind === "symlink") expect(await fs.readlink(path.join(workspace, "raced"))).toBe("../outside");
        else expect(await fs.readFile(path.join(workspace, "raced"))).toHaveLength(0);
      }
    },
  );

  it.each([
    { errno: "EACCES", code: 13, exception: "PermissionError" },
    { errno: "ENOSPC", code: 28, exception: "OSError" },
  ])("preserves a mkdir $errno failure instead of admitting a parent", async ({ errno, code, exception }) => {
    const workspace = await tempRoot("fs-safe-guest-mkdir-failure-");
    const setup = [
      "original_mkdir = os.mkdir",
      "def fail_parent_mkdir(name, *args, **kwargs):",
      "    if name == 'raced':",
      `        raise OSError(errno.${errno}, 'injected mkdir failure', name)`,
      "    return original_mkdir(name, *args, **kwargs)",
      "os.mkdir = fail_parent_mkdir",
    ].join("\n");
    const result = runGuest(parentCreationArgs("create", workspace), undefined, setup);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr.toString().trimEnd().split("\n").at(-1))
      .toBe(`${exception}: [Errno ${code}] injected mkdir failure: 'raced'`);
    expect(await fs.readdir(workspace)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("guest filesystem protocol", () => {
  it("round-trips binary bytes and literal POSIX names across filesystem operations", async () => {
    const root = await tempRoot("fs-safe-guest-roundtrip-");
    const basename = "-quoted ' name:$()\\literal.bin";
    const payload = Buffer.alloc(128 * 1024 + 17);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 256;

    const write = runGuest(["write", root, "nested", basename, "1"], payload);
    expect(write.error).toBeUndefined();
    expect(write.status, write.stderr.toString()).toBe(0);
    const read = runGuest(["read", root, "nested", basename, String(payload.length)]);
    expect(read.error).toBeUndefined();
    expect(read.status, read.stderr.toString()).toBe(0);
    expect(read.stdout).toEqual(payload);

    const copy = runGuest(["copy", root, "nested", basename, root, "copies", "copy.bin", "1"]);
    expect(copy.error).toBeUndefined();
    expect(copy.status, copy.stderr.toString()).toBe(0);
    const rename = runGuest(["rename", root, "copies", "copy.bin", root, "moved", "copy.bin", "1"]);
    expect(rename.error).toBeUndefined();
    expect(rename.status, rename.stderr.toString()).toBe(0);
    expect(await fs.readFile(path.join(root, "moved", "copy.bin"))).toEqual(payload);
    await expect(fs.lstat(path.join(root, "copies", "copy.bin"))).rejects.toMatchObject({ code: "ENOENT" });

    const mkdir = runGuest(["mkdirp", root, "moved/deeper"]);
    expect(mkdir.error).toBeUndefined();
    expect(mkdir.status, mkdir.stderr.toString()).toBe(0);
    const listing = runGuest(["readdir", root, "moved"]);
    expect(listing.error).toBeUndefined();
    expect(listing.status, listing.stderr.toString()).toBe(0);
    expect(JSON.parse(listing.stdout.toString()).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
      { name: "copy.bin", isDirectory: false },
      { name: "deeper", isDirectory: true },
    ]);

    const remove = runGuest(["remove", root, "", "moved", "1", "0"]);
    expect(remove.error).toBeUndefined();
    expect(remove.status, remove.stderr.toString()).toBe(0);
    await expect(fs.lstat(path.join(root, "moved"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, "nested", basename))).toEqual(payload);
  });

  it.each([
    { mode: 0o600, basename: "value", length: 5 },
    { mode: 0o644, basename: "n".repeat(240), length: 240 },
  ])("preserves write and copy mode $mode for $length-byte basenames", async ({ mode, basename }) => {
    const root = await tempRoot("fs-safe-guest-modes-");
    const target = path.join(root, basename);
    await fs.writeFile(target, "before");
    await fs.chmod(target, mode);

    const write = runGuest(["write", root, "", basename, "0"], "after");
    expect(write.error).toBeUndefined();
    expect(write.status, write.stderr.toString()).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("after");
    expect((await fs.stat(target)).mode & 0o777).toBe(mode);

    const copy = runGuest(["copy", root, "", basename, root, "", "copy", "0"]);
    expect(copy.error).toBeUndefined();
    expect(copy.status, copy.stderr.toString()).toBe(0);
    expect((await fs.stat(path.join(root, "copy"))).mode & 0o777).toBe(mode);
    expect((await fs.readdir(root)).sort()).toEqual([basename, "copy"].sort());
  });

  it.each([
    { name: "empty", content: "", limit: 0 },
    { name: "exact", content: "hello", limit: 5 },
    { name: "multiple chunks", content: "x".repeat(65537), limit: 65537 },
  ])("reads $name at the byte limit", async ({ content, limit }) => {
    const root = await tempRoot("fs-safe-guest-bounded-");
    await fs.writeFile(path.join(root, "value"), content);
    const result = runGuest(["read", root, "", "value", String(limit)]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stdout).toEqual(Buffer.from(content));
  });

  it.each(["oversized", "growth", "negative"])("rejects %s bounded reads", async (scenario) => {
    const root = await tempRoot("fs-safe-guest-read-rejection-");
    await fs.writeFile(path.join(root, "value"), "hello");
    const setup = scenario === "growth" ? [
      "import stat",
      "original_fstat = os.fstat",
      "grew = False",
      "def fstat_then_grow(fd):",
      "    global grew",
      "    observed = original_fstat(fd)",
      "    if not grew and stat.S_ISREG(observed.st_mode):",
      "        grew = True",
      "        with open(os.path.join(sys.argv[2], sys.argv[4]), 'ab') as output:",
      "            output.write(b'!')",
      "    return observed",
      "os.fstat = fstat_then_grow",
    ].join("\n") : undefined;
    const result = runGuest(["read", root, "", "value", scenario === "negative" ? "-1" : scenario === "growth" ? "5" : "4"], undefined, setup);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toHaveLength(0);
    expect(result.stderr.toString()).toContain(scenario === "negative" ? "non-negative" : "bounded read limit");
  });

  it.each(["", "missing-parent"])("reserves missing-read status for parent %j", async (parent) => {
    const root = await tempRoot("fs-safe-guest-missing-");
    const result = runGuest(["read", root, parent, "missing"]);
    expect(result.error).toBeUndefined();
    expect(GUEST_FILESYSTEM_READ_NOT_FOUND_EXIT_CODE).toBe(2);
    expect(result.status).toBe(GUEST_FILESYSTEM_READ_NOT_FOUND_EXIT_CODE);
    expect(result.stdout).toHaveLength(0);
  });
});

describe.skipIf(process.platform === "win32")("guest basename admission", () => {
  const single = ["read", "write", "create", "remove"].map((operation) => ({
    label: operation,
    args: [operation, "/unused-root", "nested", "value", "1", "1"],
    slot: 3,
  }));
  const dual = ["copy", "rename"].flatMap((operation) => [3, 6].map((slot) => ({
    label: `${operation} ${slot === 3 ? "source" : "destination"}`,
    args: [operation, "/unused-source", "nested", "value", "/unused-destination", "nested", "copy", "1"],
    slot,
  })));

  it.each([...single, ...dual])("rejects invalid $label leaves before opening roots", ({ args, slot }) => {
    for (const basename of ["", ".", "..", "nested/name", "/absolute", "nul\0byte"]) {
      const invocation = [...args];
      invocation[slot] = basename.includes("\0") ? "placeholder" : basename;
      const setup = [
        ...(basename.includes("\0") ? [`sys.argv[${slot + 1}] = 'nul' + chr(0) + 'byte'`] : []),
        "def unexpected_open(*args, **kwargs):",
        "    raise AssertionError('root opened before basename admission')",
        "os.open = unexpected_open",
      ].join("\n");
      const result = runGuest(invocation, undefined, setup);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr.toString()).toContain("invalid basename");
      expect(result.stderr.toString()).not.toContain("root opened before basename admission");
    }
  });
});
