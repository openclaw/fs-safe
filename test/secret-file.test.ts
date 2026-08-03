import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { FsSafeError } from "../src/errors.js";
import {
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  readSecretFileSync,
  tryReadSecretFileSync,
  writeSecretFileAtomic,
} from "../src/secret-file.js";

const { tempRoot } = useTempDirs();



function expectSecretReadCode(run: () => string, code: FsSafeError["code"]): void {
  try {
    run();
    throw new Error("Expected readSecretFileSync to throw.");
  } catch (err) {
    expect(err).toBeInstanceOf(FsSafeError);
    expect((err as FsSafeError).code).toBe(code);
  }
}

describe("secret file helpers", () => {
  it("reads trimmed secrets and exposes nullable try-read semantics", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const filePath = path.join(root, "token.txt");
    await fs.writeFile(filePath, " secret \n", "utf8");

    expect(readSecretFileSync(filePath, "API token")).toBe("secret");
    expect(tryReadSecretFileSync(filePath, "API token")).toBe("secret");
    expect(tryReadSecretFileSync(undefined, "API token")).toBeUndefined();
  });

  it("throws structured errors for strict secret reads", async () => {
    const root = await tempRoot("fs-safe-secret-errors-");
    const empty = path.join(root, "empty.txt");
    const big = path.join(root, "big.txt");
    await fs.writeFile(empty, "\n", "utf8");
    await fs.writeFile(big, "abcdef", "utf8");

    expectSecretReadCode(() => readSecretFileSync("", "API token"), "invalid-path");
    expectSecretReadCode(
      () => readSecretFileSync(path.join(root, "missing.txt"), "API token"),
      "not-found",
    );
    expectSecretReadCode(() => readSecretFileSync(root, "API token"), "not-file");
    expectSecretReadCode(
      () => readSecretFileSync(big, "API token", { maxBytes: 2 }),
      "too-large",
    );
    expectSecretReadCode(() => readSecretFileSync(empty, "API token"), "invalid-path");
  });

  it("can reject symlinked secret paths", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    const broken = path.join(root, "broken.txt");
    await fs.writeFile(target, "secret", "utf8");
    await fs.symlink(target, link);
    await fs.symlink(path.join(root, "missing.txt"), broken);

    expect(readSecretFileSync(link, "API token")).toBe("secret");
    expect(tryReadSecretFileSync(link, "API token")).toBe("secret");
    expectSecretReadCode(() => readSecretFileSync(broken, "API token"), "not-found");
    expect(tryReadSecretFileSync(broken, "API token")).toBeUndefined();
    expect(() => readSecretFileSync(link, "API token", { rejectSymlink: true })).toThrow(
      `API token file at ${link} must not be a symlink.`,
    );
    expect(() => tryReadSecretFileSync(link, "API token", { rejectSymlink: true })).toThrow(
      `API token file at ${link} must not be a symlink.`,
    );
  });

  itPosix("rejects hardlinked secret files by default", async () => {
    const root = await tempRoot("fs-safe-secret-hardlink-");
    const target = path.join(root, "target.txt");
    const link = path.join(root, "alias.txt");
    await fs.writeFile(target, "secret", "utf8");
    await fs.link(target, link);

    expectSecretReadCode(() => readSecretFileSync(link, "API token"), "hardlink");
    expect(() => tryReadSecretFileSync(link, "API token")).toThrow(
      `API token file at ${link} must not be hardlinked.`,
    );
    expect(readSecretFileSync(link, "API token", { rejectHardlinks: false })).toBe("secret");
  });

  it("treats ENOTDIR optional secret paths as missing", async () => {
    const root = await tempRoot("fs-safe-secret-enotdir-");
    const parentFile = path.join(root, "parent");
    const missingChild = path.join(parentFile, "token.txt");
    await fs.writeFile(parentFile, "not a directory", "utf8");

    expect(tryReadSecretFileSync(missingChild, "API token")).toBeUndefined();
    expectSecretReadCode(() => readSecretFileSync(missingChild, "API token"), "not-found");
  });

  it("writes private secret files under a non-symlink root", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const filePath = path.join(root, "nested", "token.txt");

    await writeSecretFileAtomic({
      rootDir: root,
      filePath,
      content: "secret\n",
    });

    expect(readSecretFileSync(filePath, "API token")).toBe("secret");
    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.dirname(filePath));
      const fileStat = await fs.stat(filePath);
      expect(dirStat.mode & 0o777).toBe(PRIVATE_SECRET_DIR_MODE);
      expect(fileStat.mode & 0o777).toBe(PRIVATE_SECRET_FILE_MODE);
    }
  });

  itPosix("keeps private secret file mode under restrictive umask", async () => {
    const root = await tempRoot("fs-safe-secret-umask-");
    const filePath = path.join(root, "token.txt");
    const oldUmask = process.umask(0o777);
    try {
      await writeSecretFileAtomic({
        rootDir: root,
        filePath,
        content: "secret\n",
      });
    } finally {
      process.umask(oldUmask);
    }

    expect((await fs.stat(filePath)).mode & 0o777).toBe(PRIVATE_SECRET_FILE_MODE);
  });

  it("accepts stricter private secret file and directory modes", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const filePath = path.join(root, "nested", "token.txt");

    await writeSecretFileAtomic({
      rootDir: root,
      filePath,
      content: "secret\n",
      mode: 0o400,
      dirMode: 0o700,
    });

    expect(readSecretFileSync(filePath, "API token")).toBe("secret");
    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.dirname(filePath));
      const fileStat = await fs.stat(filePath);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o400);
    }
  });

  it("rejects writes outside the private secret root", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const outside = await tempRoot("fs-safe-secret-outside-");

    await expect(
      writeSecretFileAtomic({
        rootDir: root,
        filePath: path.join(outside, "token.txt"),
        content: "secret\n",
      }),
    ).rejects.toThrow(`Private secret path must stay under ${root}.`);
  });
});
