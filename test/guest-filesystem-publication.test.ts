import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE } from "../src/guest.js";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe.skipIf(process.platform === "win32")("guest exclusive publication", () => {
  it("creates a long basename privately and preserves an existing destination", async () => {
    const root = await tempRoot("fs-safe-guest-create-");
    const basename = "n".repeat(240);
    const created = runGuest(["create", root, "", basename, "0"], "original");
    expect(created.error).toBeUndefined();
    expect(created.status, created.stderr.toString()).toBe(0);
    expect((await fs.stat(path.join(root, basename))).mode & 0o777).toBe(0o600);

    const collision = runGuest(["create", root, "", basename, "0"]);
    expect(collision.error).toBeUndefined();
    expect(collision.signal).toBeNull();
    expect(GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE).toBe(17);
    expect(collision.status).toBe(GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE);
    expect(await fs.readFile(path.join(root, basename), "utf8")).toBe("original");
    expect(await fs.readdir(root)).toEqual([basename]);
  });

  it.each(["native", "missing-renameat2", "unsupported-renameat2"])(
    "preserves a destination raced into %s publication",
    async (strategy) => {
      const root = await tempRoot("fs-safe-guest-create-race-");
      const fallbackSetup = strategy === "native" ? [] : [
        "import ctypes",
        "sys.platform = 'linux'",
        "class UnsupportedRename:",
        "    def __call__(self, *args):",
        "        ctypes.set_errno(errno.ENOSYS)",
        "        return -1",
        "class Libc:",
        ...(strategy === "missing-renameat2" ? ["    pass"] : ["    renameat2 = UnsupportedRename()"]),
        "ctypes.CDLL = lambda *args, **kwargs: Libc()",
      ];
      const setup = [
        ...fallbackSetup,
        "import stat",
        "original_fsync = os.fsync",
        "raced = False",
        "def publish_competitor(fd):",
        "    global raced",
        "    if not raced and stat.S_ISREG(os.fstat(fd).st_mode):",
        "        raced = True",
        "        with open(os.path.join(sys.argv[2], sys.argv[4]), 'xb') as competitor:",
        "            competitor.write(b'competitor')",
        "    return original_fsync(fd)",
        "os.fsync = publish_competitor",
      ].join("\n");
      const result = runGuest(["create", root, "", "value", "0"], "our payload", setup);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr.toString()).toBe(GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE);
      expect(await fs.readFile(path.join(root, "value"), "utf8")).toBe("competitor");
      expect(await fs.readdir(root)).toEqual(["value"]);
    },
  );

  it.each(["missing", "unsupported"])("publishes through the Linux %s renameat2 fallback", async (scenario) => {
    const root = await tempRoot("fs-safe-guest-link-fallback-");
    const setup = [
      "import ctypes",
      "sys.platform = 'linux'",
      "class UnsupportedRename:",
      "    def __call__(self, *args):",
      "        ctypes.set_errno(errno.ENOSYS)",
      "        return -1",
      "class Libc:",
      ...(scenario === "missing" ? ["    pass"] : ["    renameat2 = UnsupportedRename()"]),
      "ctypes.CDLL = lambda *args, **kwargs: Libc()",
    ].join("\n");
    const result = runGuest(["create", root, "", "value", "0"], "payload", setup);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(await fs.readFile(path.join(root, "value"), "utf8")).toBe("payload");
    expect((await fs.stat(path.join(root, "value"))).nlink).toBe(1);
    expect(await fs.readdir(root)).toEqual(["value"]);
  });

  it.each(["write", "create"])("cleans %s staging after a prepublication failure", async (operation) => {
    const root = await tempRoot("fs-safe-guest-write-failure-");
    if (operation === "write") await fs.writeFile(path.join(root, "value"), "original");
    const setup = [
      "import stat",
      "original_fsync = os.fsync",
      "def fail_payload_sync(fd):",
      "    if stat.S_ISREG(os.fstat(fd).st_mode):",
      "        raise OSError(errno.ENOSPC, 'injected payload failure')",
      "    return original_fsync(fd)",
      "os.fsync = fail_payload_sync",
    ].join("\n");
    const result = runGuest([operation, root, "", "value", "0"], "partial", setup);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("injected payload failure");
    expect(await fs.readdir(root)).toEqual(operation === "write" ? ["value"] : []);
    if (operation === "write") expect(await fs.readFile(path.join(root, "value"), "utf8")).toBe("original");
  });

  it("removes an admitted staging directory when opening it fails", async () => {
    const root = await tempRoot("fs-safe-guest-staging-open-");
    const setup = [
      "original_open = os.open",
      "def fail_staging_open(name, *args, **kwargs):",
      "    if isinstance(name, str) and name.startswith('.openclaw-create-'):",
      "        raise OSError(errno.EACCES, 'injected staging open failure')",
      "    return original_open(name, *args, **kwargs)",
      "os.open = fail_staging_open",
    ].join("\n");

    const result = runGuest(["create", root, "", "value", "0"], undefined, setup);

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("injected staging open failure");
    expect(await fs.readdir(root)).toEqual([]);
  });
});
