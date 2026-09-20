import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function traceDirectoryCloses(closeFailure?: "FileNotFoundError" | "FileExistsError"): string {
  return [
    "import atexit, json",
    "directory_owners = {}",
    "closed_directories = []",
    "root_count = 0",
    "original_open, original_dup, original_close = os.open, os.dup, os.close",
    "def observed_open(*args, **kwargs):",
    "    global root_count",
    "    fd = original_open(*args, **kwargs)",
    "    if kwargs.get('dir_fd') is None:",
    "        directory_owners[fd] = 'root:' + str(root_count)",
    "        root_count += 1",
    "    return fd",
    "def observed_dup(fd):",
    "    duplicate = original_dup(fd)",
    "    if fd in directory_owners:",
    "        directory_owners[duplicate] = directory_owners[fd].replace('root:', 'parent:')",
    "    return duplicate",
    "def observed_close(fd):",
    "    owner = directory_owners.pop(fd, None)",
    "    if owner is not None:",
    "        closed_directories.append(owner)",
    "    original_close(fd)",
    ...(closeFailure ? [
      "    if owner == 'parent:0':",
      `        raise ${closeFailure}(errno.${closeFailure === "FileNotFoundError" ? "ENOENT" : "EEXIST"}, 'dispatch cleanup failure')`,
    ] : []),
    "os.open, os.dup, os.close = observed_open, observed_dup, observed_close",
    "atexit.register(lambda: print('CLOSE_TRACE=' + json.dumps(closed_directories), file=sys.stderr))",
  ].join("\n");
}

function closedDirectories(result: ReturnType<typeof runGuest>): string[] {
  const trace = result.stderr.toString().match(/^CLOSE_TRACE=(.*)$/m);
  expect(trace).not.toBeNull();
  return JSON.parse(trace![1]!);
}

describe.skipIf(process.platform === "win32")("guest dispatch ownership and failure scopes", () => {
  it.each(["read", "write", "create", "readdir", "mkdirp", "remove", "copy", "rename"])(
    "closes the admitted %s directories in ownership order",
    async (operation) => {
      const root = await tempRoot("fs-safe-guest-dispatch-");
      await fs.writeFile(path.join(root, "source"), "content");
      const dual = operation === "copy" || operation === "rename";
      const args = dual
        ? [operation, root, "", "source", root, "", "target", "0"]
        : operation === "readdir" || operation === "mkdirp"
          ? [operation, root, ""]
          : operation === "read"
            ? [operation, root, "", "source"]
            : [operation, root, "", operation === "remove" ? "source" : "target", "0", "0"];
      const result = runGuest(args, "payload", traceDirectoryCloses());
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(closedDirectories(result)).toEqual(dual
        ? ["parent:0", "parent:1", "root:0", "root:1"]
        : ["parent:0", "root:0"]);
    },
  );

  it.each(["read", "create"])(
    "keeps %s cleanup failures outside operation exit-code handling",
    async (operation) => {
      for (const operationFails of [false, true]) {
        const root = await tempRoot("fs-safe-guest-dispatch-close-");
        if ((operation === "read") !== operationFails) {
          await fs.writeFile(path.join(root, "value"), "content");
        }
        const args = operation === "read"
          ? [operation, root, "", "value"]
          : [operation, root, "", "value", "0"];
        const result = runGuest(args, "payload", traceDirectoryCloses(
          operation === "read" ? "FileNotFoundError" : "FileExistsError",
        ));
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr.toString()).toContain("dispatch cleanup failure");
        expect(closedDirectories(result)).toEqual(["parent:0"]);
      }
    },
  );

  it("does not classify a missing read root as a missing admitted file", async () => {
    const root = await tempRoot("fs-safe-guest-read-root-");
    const result = runGuest(["read", path.join(root, "missing-root"), "", "value"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("FileNotFoundError");
  });

  it("does not classify a create parent failure as a destination collision", async () => {
    const root = await tempRoot("fs-safe-guest-create-parent-");
    const result = runGuest(["create", root, "parent", "value", "0"], "payload", [
      "original_open = os.open",
      "def reject_parent(*args, **kwargs):",
      "    if args[0] == 'parent' and kwargs.get('dir_fd') is not None:",
      "        raise FileExistsError(errno.EEXIST, 'parent admission failure')",
      "    return original_open(*args, **kwargs)",
      "os.open = reject_parent",
    ].join("\n"));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("parent admission failure");
  });

  it("does not suppress a missing removal parent with force enabled", async () => {
    const root = await tempRoot("fs-safe-guest-remove-parent-");
    const result = runGuest(["remove", root, "missing-parent", "value", "0", "1"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("FileNotFoundError");
  });
});
