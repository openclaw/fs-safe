import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE } from "../src/guest.js";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

const deferredUnlinkSetup = [
  "import ctypes",
  "sys.platform = 'linux'",
  "class UnsupportedRename:",
  "    def __call__(self, *args):",
  "        ctypes.set_errno(errno.EINVAL)",
  "        return -1",
  "class Libc:",
  "    renameat2 = UnsupportedRename()",
  "ctypes.CDLL = lambda *args, **kwargs: Libc()",
  "original_open, original_close, original_unlink = os.open, os.close, os.unlink",
  "payload_fd = None",
  "deferred_parent = None",
  "def track_payload(name, *args, **kwargs):",
  "    global payload_fd",
  "    fd = original_open(name, *args, **kwargs)",
  "    if name == 'payload': payload_fd = fd",
  "    return fd",
  "def defer_open_unlink(name, *, dir_fd=None):",
  "    global deferred_parent",
  "    if name == 'payload' and payload_fd is not None:",
  "        os.rename(name, '.nfs-test', src_dir_fd=dir_fd, dst_dir_fd=dir_fd)",
  "        deferred_parent = dir_fd",
  "        return",
  "    return original_unlink(name, dir_fd=dir_fd)",
  "def finish_close(fd):",
  "    global payload_fd, deferred_parent",
  "    original_close(fd)",
  "    if fd == payload_fd:",
  "        payload_fd = None",
  "        if deferred_parent is not None:",
  "            original_unlink('.nfs-test', dir_fd=deferred_parent)",
  "            deferred_parent = None",
  "os.open, os.close, os.unlink = track_payload, finish_close, defer_open_unlink",
].join("\n");

describe.skipIf(process.platform === "win32")("guest NFS publication", () => {
  it("closes the synced payload before a deferred-unlink fallback can leave two links", async () => {
    const root = await tempRoot("fs-safe-guest-nfs-");
    const result = runGuest(["create", root, "", "value", "0"], "complete payload", deferredUnlinkSetup);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(await fs.readFile(path.join(root, "value"), "utf8")).toBe("complete payload");
    expect((await fs.stat(path.join(root, "value"))).nlink).toBe(1);
    expect(await fs.readdir(root)).toEqual(["value"]);

    const collision = runGuest(["create", root, "", "value", "0"], "replacement", deferredUnlinkSetup);
    expect(collision.status, collision.stderr.toString()).toBe(GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE);
    expect(await fs.readFile(path.join(root, "value"), "utf8")).toBe("complete payload");
    expect(await fs.readdir(root)).toEqual(["value"]);
  });

  it("does not publish or retry a payload close that fails after releasing the descriptor", async () => {
    const root = await tempRoot("fs-safe-guest-close-");
    const setup = [
      deferredUnlinkSetup,
      "tracked_close = os.close",
      "failed_fd = None",
      "def fail_payload_close(fd):",
      "    global failed_fd",
      "    if fd == failed_fd:",
      "        raise RuntimeError('payload close retried')",
      "    is_payload = fd == payload_fd",
      "    tracked_close(fd)",
      "    if is_payload:",
      "        failed_fd = fd",
      "        raise OSError(errno.EIO, 'injected payload close failure')",
      "os.close = fail_payload_close",
    ].join("\n");
    const result = runGuest(["create", root, "", "value", "0"], "payload", setup);

    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("injected payload close failure");
    expect(result.stderr.toString()).not.toContain("payload close retried");
    expect(await fs.readdir(root)).toEqual([]);
  });
});
