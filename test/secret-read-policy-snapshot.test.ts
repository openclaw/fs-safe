import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSecretFile, tryReadSecretFile } from "../src/secret-read-async.js";
import { readSecretFileSync, tryReadSecretFileSync } from "../src/secret-file.js";
import * as realpath from "../src/realpath.js";
import type { SecretFileReadOptions } from "../src/secret-read-policy.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => vi.restoreAllMocks());

it.each(["async", "sync"] as const)(
  "reads each %s policy field exactly once",
  async (kind) => {
    const root = await tempRoot(`fs-safe-secret-policy-${kind}-`);
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const reads = { maxBytes: 0, rejectSymlink: 0, rejectHardlinks: 0 };
    const options = Object.defineProperties({} as SecretFileReadOptions, {
      maxBytes: {
        get: () => {
          reads.maxBytes++;
          return 64;
        },
      },
      rejectSymlink: {
        get: () => {
          reads.rejectSymlink++;
          return false;
        },
      },
      rejectHardlinks: {
        get: () => {
          reads.rejectHardlinks++;
          return true;
        },
      },
    });

    const value = kind === "async"
      ? await readSecretFile(filePath, "token", options)
      : readSecretFileSync(filePath, "token", options);

    expect(value).toBe("secret");
    expect(reads).toEqual({ maxBytes: 1, rejectSymlink: 1, rejectHardlinks: 1 });
  },
);

it.each(["async", "sync"] as const)(
  "preserves a missing-file result before the %s hardlink policy is read",
  async (kind) => {
    const root = await tempRoot(`fs-safe-secret-policy-missing-${kind}-`);
    const options = Object.defineProperty({} as SecretFileReadOptions, "rejectHardlinks", {
      get: () => {
        throw new Error("must not be read");
      },
    });

    const value = kind === "async"
      ? await tryReadSecretFile(path.join(root, "missing"), "token", options)
      : tryReadSecretFileSync(path.join(root, "missing"), "token", options);

    expect(value).toBeUndefined();
  },
);

itPosix.each(["async", "sync"] as const)(
  "preserves %s symlink rejection before the hardlink policy is read",
  async (kind) => {
    const root = await tempRoot(`fs-safe-secret-policy-rejected-link-${kind}-`);
    const targetPath = path.join(root, "target");
    const filePath = path.join(root, "secret");
    await fs.writeFile(targetPath, "secret", { mode: 0o600 });
    fsSync.symlinkSync(targetPath, filePath);
    const options = Object.defineProperty(
      { rejectSymlink: true } as SecretFileReadOptions,
      "rejectHardlinks",
      {
        get: () => {
          throw new Error("must not be read");
        },
      },
    );

    const read = kind === "async"
      ? readSecretFile(filePath, "token", options)
      : Promise.resolve().then(() => readSecretFileSync(filePath, "token", options));
    await expect(read).rejects.toMatchObject({ code: "symlink" });
  },
);

itPosix("keeps initial symlink rejection after the options object is relaxed", async () => {
  const root = await tempRoot("fs-safe-secret-policy-symlink-");
  const filePath = path.join(root, "secret");
  const displaced = path.join(root, "displaced");
  await fs.writeFile(filePath, "secret", { mode: 0o600 });
  const options: SecretFileReadOptions = { rejectSymlink: true };

  const nativeRealpath = realpath.realpathSync.native;
  vi.spyOn(realpath.realpathSync, "native").mockImplementationOnce((...args) => {
    fsSync.renameSync(filePath, displaced);
    fsSync.symlinkSync(displaced, filePath);
    options.rejectSymlink = false;
    return nativeRealpath(...args);
  });

  await expect(readSecretFile(filePath, "token", options)).rejects.toMatchObject({ code: "symlink" });
});

itPosix("keeps default hardlink rejection after the options object is relaxed", async () => {
  const root = await tempRoot("fs-safe-secret-policy-hardlink-");
  const filePath = path.join(root, "secret");
  const aliasPath = path.join(root, "alias");
  await fs.writeFile(filePath, "secret", { mode: 0o600 });
  const options: SecretFileReadOptions = {};
  const realOpen = fs.open.bind(fs);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    entered.resolve();
    await release.promise;
    return handle;
  });

  const pending = readSecretFile(filePath, "token", options);
  try {
    await entered.promise;
    fsSync.linkSync(filePath, aliasPath);
    options.rejectHardlinks = false;
  } finally {
    release.resolve();
  }

  await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
});
