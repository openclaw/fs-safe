import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { FsSafeError } from "../src/errors.js";
import {
  formatPermissionRemediation,
  inspectPathPermissions,
  type PermissionCheck,
} from "../src/permissions.js";
import { readSecretFile } from "../src/secret-read-async.js";
import { readSecretFileSync } from "../src/secret-file.js";
import { readSecureFile } from "../src/secure-file.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

function expectCode(error: unknown, code: FsSafeError["code"]): boolean {
  expect(error).toBeInstanceOf(FsSafeError);
  expect((error as FsSafeError).code).toBe(code);
  return true;
}

describe("permission and secret stress matrix", () => {
  itPosix.each([
    [0o400, true],
    [0o500, true],
    [0o600, true],
    [0o700, true],
    [0o440, false],
    [0o604, false],
    [0o620, false],
    [0o602, false],
  ] as const)("classifies secure-file mode %s independently of owner execute bits", async (mode, accepted) => {
    const root = await tempRoot("fs-safe-secure-mode-matrix-");
    const filePath = path.join(root, "credential");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    await fs.chmod(filePath, mode);

    const permissions = await inspectPathPermissions(filePath);
    expect(permissions.bits).toBe(mode);

    const read = readSecureFile({ filePath });
    if (accepted) {
      await expect(read).resolves.toMatchObject({ buffer: Buffer.from("secret") });
    } else {
      await expect(read).rejects.toSatisfy((error: unknown) =>
        expectCode(error, "insecure-permissions"),
      );
    }
  });

  itPosix("allows read-only group/world access only through the explicit option", async () => {
    const root = await tempRoot("fs-safe-secure-readable-");
    for (const mode of [0o440, 0o404]) {
      const filePath = path.join(root, `credential-${mode.toString(8)}`);
      await fs.writeFile(filePath, "secret", { mode: 0o600 });
      await fs.chmod(filePath, mode);

      await expect(
        readSecureFile({ filePath, permissions: { allowReadableByOthers: true } }),
      ).resolves.toMatchObject({ buffer: Buffer.from("secret") });
    }

    for (const mode of [0o620, 0o602]) {
      const filePath = path.join(root, `credential-${mode.toString(8)}`);
      await fs.writeFile(filePath, "secret", { mode: 0o600 });
      await fs.chmod(filePath, mode);

      await expect(
        readSecureFile({ filePath, permissions: { allowReadableByOthers: true } }),
      ).rejects.toSatisfy((error: unknown) => expectCode(error, "insecure-permissions"));
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

  it("shell-quotes unsafe POSIX remediation paths", () => {
    const perms: PermissionCheck = {
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

    expect(
      formatPermissionRemediation({
        targetPath: "/tmp/token; touch /tmp/unintended",
        perms,
        isDir: false,
        posixMode: 0o600,
      }),
    ).toBe("chmod 600 '/tmp/token; touch /tmp/unintended'");
    expect(
      formatPermissionRemediation({
        targetPath: "/tmp/owner's token",
        perms,
        isDir: false,
        posixMode: 0o600,
      }),
    ).toBe("chmod 600 '/tmp/owner'\\''s token'");
    expect(
      formatPermissionRemediation({
        targetPath: "-unexpected-option",
        perms,
        isDir: false,
        posixMode: 0o600,
      }),
    ).toBe("chmod 600 -- -unexpected-option");
  });
});
