import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const FORCE_EXDEV = `
_test_original_rename = os.rename
def _test_after_publication():
    pass
def _test_rename(source, destination, *args, **kwargs):
    if source == sys.argv[4] and destination == sys.argv[7]:
        raise OSError(errno.EXDEV, 'forced cross-device rename')
    result = _test_original_rename(source, destination, *args, **kwargs)
    if destination == sys.argv[7]:
        _test_after_publication()
    return result
os.rename = _test_rename
`;

describe.skipIf(process.platform === "win32")("guest filesystem cross-device recovery", () => {
  const { tempRoot } = useRealTempDirs();

  async function fixture(payload: Buffer | string = "payload") {
    const directory = await tempRoot("fs-safe-guest-recovery-");
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(path.join(source, "tree", "nested"), { recursive: true });
    await fs.mkdir(destination);
    await fs.writeFile(path.join(source, "tree", "nested", "file.txt"), payload);
    return {
      directory,
      source,
      destination,
      args: ["rename", source, "", "tree", destination, "", "moved", "1"],
    };
  }

  it("publishes a directory with a long destination basename before removing its source after EXDEV", async () => {
    const payload = Buffer.alloc(65_573, 0x6b);
    const { source, destination, args } = await fixture(payload);
    const basename = "d".repeat(240);
    args[6] = basename;
    await fs.chmod(path.join(source, "tree", "nested", "file.txt"), 0o751);
    await fs.symlink("nested/file.txt", path.join(source, "tree", "alias"));

    const result = runGuest(args, undefined, FORCE_EXDEV);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(await fs.readFile(path.join(destination, basename, "nested", "file.txt"))).toEqual(payload);
    expect((await fs.stat(path.join(destination, basename, "nested", "file.txt"))).mode & 0o777).toBe(0o751);
    expect(await fs.readlink(path.join(destination, basename, "alias"))).toBe("nested/file.txt");
    expect(await fs.readdir(source)).toEqual([]);
    expect(await fs.readdir(destination)).toEqual([basename]);
  });

  it("atomically replaces a long destination basename during a file move after EXDEV", async () => {
    const payload = Buffer.alloc(65_573, 0x6b);
    const { source, destination } = await fixture(payload);
    const basename = "f".repeat(240);
    const sourceFile = path.join(source, "tree", "nested", "file.txt");
    const destinationFile = path.join(destination, basename);
    await fs.chmod(sourceFile, 0o751);
    await fs.writeFile(destinationFile, "previous");

    const result = runGuest([
      "rename", source, "tree/nested", "file.txt", destination, "", basename, "0",
    ], undefined, FORCE_EXDEV);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(await fs.readFile(destinationFile)).toEqual(payload);
    expect((await fs.stat(destinationFile)).mode & 0o777).toBe(0o751);
    expect(await fs.readdir(path.dirname(sourceFile))).toEqual([]);
    expect(await fs.readdir(destination)).toEqual([basename]);
  });

  it("retains the source and removes destination staging when a copied child is hardlinked", async () => {
    const { directory, source, destination, args } = await fixture();
    const retained = path.join(directory, "retained.txt");
    await fs.writeFile(retained, "retained data");
    await fs.link(retained, path.join(source, "tree", "nested", "linked.txt"));

    const result = runGuest(args, undefined, FORCE_EXDEV);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("hardlinked file is not allowed");
    expect(await fs.readFile(path.join(source, "tree", "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await fs.readFile(path.join(source, "tree", "nested", "linked.txt"), "utf8")).toBe("retained data");
    expect(await fs.readFile(retained, "utf8")).toBe("retained data");
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it("retains the published copy and source when a file is added after copying", async () => {
    const { source, destination, args } = await fixture();
    await fs.utimes(path.join(source, "tree"), 1, 1);
    const setup = `${FORCE_EXDEV}
def _test_after_publication():
    source_tree = os.path.join(sys.argv[2], sys.argv[3], sys.argv[4])
    with open(os.path.join(source_tree, 'late.txt'), 'xb') as late:
        late.write(b'late data')
`;

    const result = runGuest(args, undefined, setup);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("source changed during move fallback cleanup");
    expect(await fs.readFile(path.join(destination, "moved", "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await fs.readFile(path.join(source, "tree", "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await fs.readFile(path.join(source, "tree", "late.txt"), "utf8")).toBe("late data");
    expect(await fs.readdir(path.join(destination, "moved"))).toEqual(["nested"]);
    expect(await fs.readdir(destination)).toEqual(["moved"]);
  });

  it("retains the published copy and replacement when a copied source file is replaced", async () => {
    const { source, destination, args } = await fixture();
    const setup = `${FORCE_EXDEV}
def _test_after_publication():
    source_directory = os.path.join(sys.argv[2], sys.argv[3], sys.argv[4], 'nested')
    replacement = os.path.join(source_directory, 'replacement.txt')
    with open(replacement, 'xb') as output:
        output.write(b'replacement data')
    os.replace(replacement, os.path.join(source_directory, 'file.txt'))
`;

    const result = runGuest(args, undefined, setup);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("source changed during move fallback cleanup");
    expect(await fs.readFile(path.join(destination, "moved", "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await fs.readFile(path.join(source, "tree", "nested", "file.txt"), "utf8")).toBe("replacement data");
    expect(await fs.readdir(path.join(source, "tree", "nested"))).toEqual(["file.txt"]);
    expect(await fs.readdir(destination)).toEqual(["moved"]);
  });
});
