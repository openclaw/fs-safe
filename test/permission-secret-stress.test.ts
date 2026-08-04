import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  formatPermissionRemediation,
  inspectPathPermissions,
  type PermissionCheck,
} from "../src/permissions.js";
import { readSecretFile } from "../src/secret-read-async.js";
import { readSecretFileSync } from "../src/secret-file.js";
import { readSecureFile } from "../src/secure-file.js";

const { tempRoot } = useTempDirs();
const POSIX_PERMISSIONS: PermissionCheck = {
  ok: true,
  isSymlink: false,
  isDir: false,
  mode: 0o100644,
  bits: 0o644,
  source: "posix",
  worldWritable: false,
  groupWritable: false,
  worldReadable: true,
  groupReadable: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("permission and secret stress matrix", () => {
  itPosix.each([
    [0o400, false, true],
    [0o500, false, true],
    [0o600, false, true],
    [0o700, false, true],
    [0o440, false, false],
    [0o404, false, false],
    [0o440, true, true],
    [0o404, true, true],
    [0o620, true, false],
    [0o602, true, false],
  ] as const)("classifies secure-file mode %s (allow readable=%s)", async (
    mode,
    allowReadableByOthers,
    accepted,
  ) => {
    const root = await tempRoot("fs-safe-secure-mode-matrix-");
    const filePath = path.join(root, "credential");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    await fs.chmod(filePath, mode);

    const permissions = await inspectPathPermissions(filePath);
    expect(permissions.bits).toBe(mode);

    const read = readSecureFile({ filePath, permissions: { allowReadableByOthers } });
    if (accepted) {
      await expect(read).resolves.toMatchObject({ buffer: Buffer.from("secret") });
    } else {
      await expect(read).rejects.toMatchObject({
        name: "FsSafeError",
        code: "insecure-permissions",
      });
    }
  });

  itPosix("reports a concurrent size increase as too-large in sync and async readers", async () => {
    const root = await tempRoot("fs-safe-secret-growth-");
    const syncPath = path.join(root, "sync-token");
    const asyncPath = path.join(root, "async-token");
    await fs.writeFile(syncPath, "abc");
    await fs.writeFile(asyncPath, "abc");

    const realpathSync = fsSync.realpathSync.bind(fsSync);
    vi.spyOn(fsSync, "realpathSync").mockImplementationOnce((target, options) => {
      fsSync.appendFileSync(syncPath, "def");
      return realpathSync(target, options as never);
    });
    expect(() => readSecretFileSync(syncPath, "sync token", { maxBytes: 3 })).toThrow(
      expect.objectContaining({ code: "too-large" }),
    );

    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementationOnce(async (target, options) => {
      await fs.appendFile(asyncPath, "def");
      return await realpath(target, options as never);
    });
    await expect(readSecretFile(asyncPath, "async token", { maxBytes: 3 })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it.each([
    ["/tmp/token; touch /tmp/unintended", "chmod 600 '/tmp/token; touch /tmp/unintended'"],
    ["/tmp/owner's token", "chmod 600 '/tmp/owner'\\''s token'"],
    ["-unexpected-option", "chmod 600 -- -unexpected-option"],
  ])("shell-quotes POSIX remediation path %s", (targetPath, expected) => {
    expect(
      formatPermissionRemediation({
        targetPath,
        perms: POSIX_PERMISSIONS,
        isDir: false,
        posixMode: 0o600,
      }),
    ).toBe(expected);
  });
});
