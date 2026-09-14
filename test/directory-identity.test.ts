import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDirectoryIdentitySync, readDirectoryIdentity } from "../src/advanced.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

describe("public directory identity observations", () => {
  it("returns a frozen exact identity without changing the directory or its contents", async () => {
    const directory = await tempRoot("fs-safe-directory-observation-");
    const file = path.join(directory, "keep");
    await fs.writeFile(file, "caller-owned");
    const before = await fs.lstat(directory, { bigint: true });

    const observed = await readDirectoryIdentity(directory);

    expect(observed).toEqual({ dev: before.dev, ino: before.ino, realPath: directory });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(assertDirectoryIdentitySync(directory, observed)).toBeUndefined();
    expect(await fs.lstat(directory, { bigint: true })).toMatchObject({
      dev: before.dev, ino: before.ino, mode: before.mode,
    });
    expect(await fs.readdir(directory)).toEqual(["keep"]);
    expect(await fs.readFile(file, "utf8")).toBe("caller-owned");
  });

  it("checks the observed path while allowing moved receipts without an expected realpath", async () => {
    const base = await tempRoot("fs-safe-directory-moved-");
    const original = path.join(base, "original");
    const moved = path.join(base, "moved");
    await fs.mkdir(original);
    await fs.writeFile(path.join(original, "keep"), "original");
    const observed = await readDirectoryIdentity(original);
    await fs.rename(original, moved);
    await fs.mkdir(original);
    await fs.writeFile(path.join(original, "keep"), "replacement");
    const receipt = { dev: observed.dev, ino: observed.ino, path: original };

    expect(assertDirectoryIdentitySync(moved, receipt)).toBeUndefined();
    expect(() => assertDirectoryIdentitySync(moved, observed))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(() => assertDirectoryIdentitySync(original, receipt))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(await fs.readFile(path.join(moved, "keep"), "utf8")).toBe("original");
    expect(await fs.readFile(path.join(original, "keep"), "utf8")).toBe("replacement");
  });

  it.each(["file", "directory link"] as const)("rejects a final %s without following or changing it", async kind => {
    const base = await tempRoot("fs-safe-directory-kind-");
    const directory = path.join(base, "directory");
    const candidate = path.join(base, "candidate");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "keep"), "untouched");
    const expected = await readDirectoryIdentity(directory);
    if (kind === "file") await fs.writeFile(candidate, "not a directory");
    else await fs.symlink(directory, candidate, process.platform === "win32" ? "junction" : "dir");

    await expect(readDirectoryIdentity(candidate)).rejects.toMatchObject({ code: "not-file" });
    expect(() => assertDirectoryIdentitySync(candidate, expected))
      .toThrow(expect.objectContaining({ code: "not-file" }));
    expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("untouched");
    if (kind === "file") expect(await fs.readFile(candidate, "utf8")).toBe("not a directory");
    else expect((await fs.lstat(candidate)).isSymbolicLink()).toBe(true);
  });

  it("does not collapse different exact inodes into the same numeric identity", async () => {
    const base = await tempRoot("fs-safe-directory-wide-identity-");
    const directory = path.join(base, "directory");
    await fs.mkdir(directory);
    const first = 9007199254740992n;
    expect(Number(first)).toBe(Number(first + 1n));
    let replaced = false;
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (String(args[0]) !== directory) return stat;
      const ino = first + (replaced ? 1n : 0n);
      return Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
    });
    const expected = await readDirectoryIdentity(directory);
    expect(expected.ino).toBe(first);
    await fs.rename(directory, path.join(base, "preserved"));
    await fs.mkdir(directory);
    replaced = true;

    expect(() => assertDirectoryIdentitySync(directory, expected))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect((await fs.lstat(directory)).isDirectory()).toBe(true);
    expect((await fs.lstat(path.join(base, "preserved"))).isDirectory()).toBe(true);
  });

  describe.each(["read", "assert"] as const)("%s failure contracts", operation => {
    it.each(["transient unknown", "persistent unknown", "known component changes"] as const)(
      "keeps Windows identity observations bounded: %s",
      async scenario => {
        const directory = await tempRoot("fs-safe-directory-windows-identity-");
        const expected = await readDirectoryIdentity(directory);
        Object.defineProperty(process, "platform", { value: "win32" });
        const lstat = fsSync.lstatSync.bind(fsSync);
        let observations = 0;
        vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
          const stat = lstat(...args);
          if (String(args[0]) !== directory) return stat;
          observations++;
          if (scenario === "known component changes" && observations === 1) {
            return Object.assign(Object.create(stat), { dev: 0n, ino: expected.ino + 1n });
          }
          if (scenario === "persistent unknown" || observations === 1) {
            return Object.assign(Object.create(stat), { dev: 0n });
          }
          return stat;
        });
        const run = () => operation === "read"
          ? readDirectoryIdentity(directory)
          : assertDirectoryIdentitySync(directory, expected);

        if (scenario === "transient unknown") {
          await run();
          expect(observations).toBe(2);
        } else {
          await expect(async () => await run()).rejects.toMatchObject({ code: "path-mismatch" });
          expect(observations).toBe(operation === "assert" && scenario === "known component changes" ? 1 : 2);
        }
      },
    );

    it("preserves missing-path and operational errors without retrying them", async () => {
      const directory = await tempRoot("fs-safe-directory-errors-");
      const expected = await readDirectoryIdentity(directory);
      const run = (observedPath: string) => operation === "read"
        ? readDirectoryIdentity(observedPath)
        : assertDirectoryIdentitySync(observedPath, expected);
      await expect(async () => await run(path.join(directory, "missing")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const failure = Object.assign(new Error("inspection denied"), { code: "EACCES" });
      const lstat = fsSync.lstatSync.bind(fsSync);
      let attempts = 0;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        if (String(args[0]) === directory) {
          attempts++;
          throw failure;
        }
        return lstat(...args);
      });
      await expect(async () => await run(directory)).rejects.toBe(failure);
      expect(attempts).toBe(1);
    });
  });
});
