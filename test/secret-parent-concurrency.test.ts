import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const writers = [
  { operation: "write", write: writeSecretFileAtomic },
  { operation: "create", write: createSecretFileAtomic },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secret parent creation contention", () => {
  it.each(writers)("$operation admits distinct leaves racing at the real parent mkdir", async ({ write }) => {
    const rootDir = await tempRoot("fs-safe-secret-parent-race-");
    const parent = path.join(rootDir, "shared");
    const inputs = [
      { filePath: path.join(parent, "first"), content: Buffer.from([0, 10, 128, 255]) },
      { filePath: path.join(parent, "second"), content: Buffer.from("second secret\n") },
    ];
    const ready = Promise.withResolvers<void>();
    let arrivals = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const mkdirErrors: unknown[] = [];
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
      if (String(candidate) !== parent) return await mkdir(candidate, options);
      expect(options).toEqual({ mode: 0o700 });
      arrivals++;
      if (arrivals === 1) {
        timer = setTimeout(() => ready.reject(new Error("both writers must reach parent mkdir")), 2_000);
      } else if (arrivals === 2) {
        clearTimeout(timer);
        ready.resolve();
      }
      await ready.promise;
      try {
        return await mkdir(candidate, options);
      } catch (error) {
        mkdirErrors.push(error);
        throw error;
      }
    });

    try {
      const results = await Promise.allSettled(inputs.map((input) => write({ rootDir, ...input })));
      expect(arrivals).toBe(2);
      expect(mkdirErrors).toEqual([expect.objectContaining({ code: "EEXIST" })]);
      expect(results).toEqual(inputs.map(() => ({ status: "fulfilled", value: undefined })));
      for (const input of inputs) {
        expect(await fs.readFile(input.filePath)).toEqual(input.content);
        const stat = await fs.lstat(input.filePath);
        expect(stat.isFile()).toBe(true);
        expect(stat.nlink).toBe(1);
        if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
      }
      if (process.platform !== "win32") expect((await fs.stat(parent)).mode & 0o777).toBe(0o700);
      expect((await fs.readdir(parent)).sort()).toEqual(["first", "second"]);
    } finally {
      clearTimeout(timer);
    }
  }, 5_000);

  it("keeps same-leaf creates first-writer-wins under a missing parent", async () => {
    const rootDir = await tempRoot("fs-safe-secret-same-leaf-");
    const parent = path.join(rootDir, "shared");
    const filePath = path.join(parent, "token");
    const contents = [Buffer.from("first\n"), Buffer.from([0, 127, 255])];
    const results = await Promise.allSettled(contents.map((content) =>
      createSecretFileAtomic({ rootDir, filePath, content }),
    ));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBeInstanceOf(FsSafeError);
    expect(failures[0]!.reason).toMatchObject({ code: "secret-exists" });
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(await fs.readFile(filePath)).toEqual(contents[winner]);
    expect(await fs.readdir(parent)).toEqual(["token"]);
  });

  for (const outcome of ["EEXIST", "success"] as const) {
    it.each(writers)(`$operation rejects a file substituted at parent mkdir ${outcome}`, async ({ write }) => {
      const rootDir = await tempRoot("fs-safe-secret-parent-file-");
      const parent = path.join(rootDir, "shared");
      const mkdir = fs.mkdir.bind(fs);
      let injected = false;
      vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
        if (String(candidate) !== parent) return await mkdir(candidate, options);
        if (outcome === "success") {
          await mkdir(candidate, options);
          await fs.rmdir(parent);
        }
        await fs.writeFile(parent, "keep parent file", { flag: "wx", mode: 0o400 });
        injected = true;
        if (outcome === "EEXIST") return await mkdir(candidate, options);
      });

      await expect(write({ rootDir, filePath: path.join(parent, "token"), content: "secret" }))
        .rejects.toThrow(`Private secret directory component ${parent} must be a directory.`);
      expect(injected).toBe(true);
      expect(await fs.readFile(parent, "utf8")).toBe("keep parent file");
      if (process.platform !== "win32") expect((await fs.stat(parent)).mode & 0o777).toBe(0o400);
      await expect(fs.lstat(path.join(parent, "token"))).rejects.toMatchObject({
        code: expect.stringMatching(/^(ENOENT|ENOTDIR)$/),
      });
      expect(await fs.readdir(rootDir)).toEqual(["shared"]);
    });

    it.each(writers)(`$operation rejects an in-root symlink substituted at parent mkdir ${outcome}`, async ({ write }) => {
      const rootDir = await tempRoot("fs-safe-secret-parent-link-");
      const parent = path.join(rootDir, "shared");
      const referent = path.join(rootDir, "referent");
      await fs.mkdir(referent, { mode: 0o700 });
      await fs.writeFile(path.join(referent, "keep"), "untouched");
      const mkdir = fs.mkdir.bind(fs);
      let injected = false;
      vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
        if (String(candidate) !== parent) return await mkdir(candidate, options);
        if (outcome === "success") {
          await mkdir(candidate, options);
          await fs.rmdir(parent);
        }
        await fs.symlink(referent, parent, process.platform === "win32" ? "junction" : "dir");
        injected = true;
        if (outcome === "EEXIST") return await mkdir(candidate, options);
      });

      await expect(write({ rootDir, filePath: path.join(parent, "token"), content: "secret" }))
        .rejects.toThrow(`Private secret directory component ${parent} must not be a symlink.`);
      expect(injected).toBe(true);
      expect((await fs.lstat(parent)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(parent)).toBe(referent);
      expect(await fs.readFile(path.join(referent, "keep"), "utf8")).toBe("untouched");
      expect(await fs.readdir(referent)).toEqual(["keep"]);
      await expect(fs.lstat(path.join(parent, "token"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  for (const ancestor of ["root", "parent"] as const) {
    it.each(writers)(`$operation retains the ${ancestor} guard across an EEXIST retry`, async ({ write }) => {
      const sandbox = await tempRoot("fs-safe-secret-parent-guard-");
      const rootDir = path.join(sandbox, "root");
      const existing = path.join(rootDir, "existing");
      const parent = path.join(existing, "shared");
      const moved = path.join(sandbox, "moved");
      await fs.mkdir(existing, { recursive: true, mode: 0o700 });
      const mkdir = fs.mkdir.bind(fs);
      let injected = false;
      vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
        if (String(candidate) === parent) {
          await fs.rename(ancestor === "root" ? rootDir : existing, moved);
          await mkdir(parent, { recursive: true, mode: 0o700 });
          injected = true;
        }
        return await mkdir(candidate, options);
      });

      await expect(write({ rootDir, filePath: path.join(parent, "token"), content: "secret" }))
        .rejects.toMatchObject({ code: "path-mismatch" });
      expect(injected).toBe(true);
      expect(await fs.readdir(parent)).toEqual([]);
      const originalParent = ancestor === "root" ? path.join(moved, "existing") : moved;
      expect(await fs.readdir(originalParent)).toEqual([]);
    });
  }

  it.each(writers)("$operation propagates unexpected parent mkdir errors unchanged", async ({ write }) => {
    const rootDir = await tempRoot("fs-safe-secret-parent-errno-");
    const parent = path.join(rootDir, "shared");
    const failure = Object.assign(new Error("mkdir I/O failure"), { code: "EIO" });
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
      if (String(candidate) === parent) throw failure;
      return await mkdir(candidate, options);
    });

    await expect(write({ rootDir, filePath: path.join(parent, "token"), content: "secret" }))
      .rejects.toBe(failure);
    expect(await fs.readdir(rootDir)).toEqual([]);
  });
});
