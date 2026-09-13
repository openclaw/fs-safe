import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_FILESYSTEM_READ_NOT_FOUND_EXIT_CODE } from "../src/guest.js";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

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

  it.each([0o600, 0o644])("preserves existing write mode %i and source copy mode", async (mode) => {
    const root = await tempRoot("fs-safe-guest-modes-");
    const target = path.join(root, "value");
    await fs.writeFile(target, "before");
    await fs.chmod(target, mode);

    const write = runGuest(["write", root, "", "value", "0"], "after");
    expect(write.error).toBeUndefined();
    expect(write.status, write.stderr.toString()).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("after");
    expect((await fs.stat(target)).mode & 0o777).toBe(mode);

    const copy = runGuest(["copy", root, "", "value", root, "", "copy", "0"]);
    expect(copy.error).toBeUndefined();
    expect(copy.status, copy.stderr.toString()).toBe(0);
    expect((await fs.stat(path.join(root, "copy"))).mode & 0o777).toBe(mode);
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
