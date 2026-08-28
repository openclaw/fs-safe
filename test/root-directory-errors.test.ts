import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { ensureDirectoryWithinRoot, pathScope } from "../src/advanced.js";
import { itDarwin, itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempDirs, tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

type DirectoryResult = Awaited<ReturnType<typeof ensureDirectoryWithinRoot>>;

function expectOperational(result: DirectoryResult, cause: unknown, code: string, syscall: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected directory failure");
  expect(result.diagnostic).toBeInstanceOf(FsSafeError);
  expect(result.diagnostic).toMatchObject({ code: "helper-failed", category: "operational" });
  expect(result.diagnostic?.cause).toBe(cause);
  expect(result.error).toBe(result.diagnostic?.message);
  expect(result.error).toContain(`${code} during ${syscall}`);
  expect(result.error).not.toContain("must stay within");
}

describe("root directory operational diagnostics", () => {
  it.each([
    ["lstat", "EACCES"],
    ["mkdir", "ENOSPC"],
    ["realpath", "EIO"],
  ] as const)("preserves %s %s through both public entry points", async (syscall, code) => {
    const rootDir = await tempRoot("fs-safe-dir-error-");
    const cause = Object.assign(new Error("native failure with private path"), {
      code, errno: -1, syscall, path: path.join(rootDir, "child"),
    });
    for (const entry of ["helper", "scope"] as const) {
      const spy = vi.spyOn(fs, syscall).mockRejectedValueOnce(cause);
      const result = entry === "helper"
        ? await ensureDirectoryWithinRoot({ rootDir, requestedPath: "child", scopeLabel: "uploads" })
        : await pathScope(rootDir, { label: "uploads" }).ensureDir("child");
      expectOperational(result, cause, code, syscall);
      expect(result).toMatchObject({ diagnostic: { cause: { code, errno: -1, syscall } } });
      spy.mockRestore();
      expect(await fs.readdir(rootDir)).toEqual([]);
    }
  });

  it.each([
    ["root lstat", "lstat", "root", 1],
    ["symlink walk", "lstat", "child", 1],
    ["nearest ancestor", "lstat", "child", 2],
    ["creation lookup", "lstat", "child", 3],
    ["created directory reinspection", "lstat", "child", 4],
    ["root realpath", "realpath", "root", 1],
    ["ancestor realpath", "realpath", "root", 2],
    ["segment realpath", "realpath", "child", 1],
    ["final realpath", "realpath", "child", 2],
  ] as const)("retains I/O failure at %s", async (_stage, syscall, location, occurrence) => {
    const rootDir = await tempRoot("fs-safe-dir-stage-");
    const target = location === "root" ? rootDir : path.join(rootDir, "child");
    const cause = Object.assign(new Error("I/O failure"), { code: "EIO", errno: -5, syscall });
    const original = fs[syscall].bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, syscall).mockImplementation(async (...args) => {
      if (String(args[0]) === target && ++calls === occurrence) throw cause;
      return await original(...args);
    });
    const result = await pathScope(rootDir, { label: "uploads" }).ensureDir("child");
    expectOperational(result, cause, "EIO", syscall);
    expect(calls).toBe(occurrence);
    spy.mockRestore();
    expect(await fs.readdir(rootDir)).toEqual(
      ["created directory reinspection", "segment realpath", "final realpath"].includes(_stage)
        ? ["child"] : [],
    );
  });

  it("bounds and escapes display fields without dumping paths or native messages", async () => {
    const rootDir = await tempRoot("fs-safe-dir-display-");
    const cause = Object.assign(new Error(`private-path/${"secret".repeat(1000)}\nforged log`), {
      code: `EIO\n${"x".repeat(1000)}`,
      syscall: `lstat\r${"y".repeat(1000)}`,
      path: path.join(rootDir, "secret"),
    });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(cause);
    const result = await pathScope(rootDir, { label: `uploads\n${"z".repeat(1000)}` })
      .ensureDir("requested-secret");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected directory failure");
    expect(result.diagnostic?.cause).toBe(cause);
    expect(result.error).toContain("uploads\\u000a");
    expect(result.error).toContain("EIO\\u000a");
    expect(result.error).toContain("lstat\\u000d");
    expect(result.error.length).toBeLessThan(1100);
    expect(result.error).not.toMatch(/[\r\n]|secret|private-path/u);
    expect(result.error).not.toContain(rootDir);
  });

  it.each([new Error("private failure"), null, { code: 123, syscall: 456 }])(
    "retains unexpected non-errno failures without rejecting",
    async (cause) => {
      const rootDir = await tempRoot("fs-safe-dir-unexpected-");
      vi.spyOn(fs, "lstat").mockRejectedValueOnce(cause);
      const result = await pathScope(rootDir, { label: "uploads" }).ensureDir("child");
      expect(result).toMatchObject({ ok: false, diagnostic: { category: "operational" } });
      if (result.ok) throw new Error("expected directory failure");
      expect(result.diagnostic?.cause).toBe(cause);
      expect(result.error).toContain("Could not prepare uploads");
      expect(result.error).not.toContain("private failure");
    },
  );

  itPosix("reports a 256-byte component before and after creating its missing parents", async () => {
    const rootDir = await tempRoot("fs-safe-dir-name-");
    const scope = pathScope(rootDir, { label: "uploads" });
    const valid = path.join("valid", "date", "a".repeat(255));
    await expect(scope.ensureDir(valid)).resolves.toEqual({ ok: true, path: path.join(rootDir, valid) });
    const requestedPath = path.join("missing", "date", "a".repeat(256));
    const target = path.join(rootDir, requestedPath);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const realLstat = fs.lstat.bind(fs);
    const causes: unknown[] = [];
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      try {
        return await realLstat(...args);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENAMETOOLONG") causes.push(cause);
        throw cause;
      }
    });
    for (const [attempt, entry] of (["helper", "helper", "scope"] as const).entries()) {
      const result = entry === "helper"
        ? await ensureDirectoryWithinRoot({ rootDir, requestedPath, scopeLabel: "uploads" })
        : await scope.ensureDir(requestedPath);
      expect(causes).toHaveLength(attempt + 1);
      expectOperational(result, causes.at(-1), "ENAMETOOLONG", "lstat");
      expect(await fs.readdir(path.dirname(target))).toEqual([]);
    }
  });

  itPosix("returns a real permission-denied mkdir without throwing", async (context) => {
    const rootDir = await tempRoot("fs-safe-dir-permission-");
    const parent = path.join(rootDir, "locked");
    await fs.mkdir(parent, { mode: 0o500 });
    try {
      const probe = path.join(parent, "probe");
      const denied = await fs.mkdir(probe).then(() => undefined, (cause: unknown) => cause);
      if (denied === undefined) {
        await fs.rmdir(probe);
        context.skip("host permits mkdir in a mode 0500 directory");
        return;
      }
      expect(denied).toMatchObject({ code: "EACCES", syscall: "mkdir" });
      const realMkdir = fs.mkdir.bind(fs);
      let nativeCause: unknown;
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        try {
          return await realMkdir(...args);
        } catch (cause) {
          nativeCause = cause;
          throw cause;
        }
      });
      const result = await pathScope(rootDir, { label: "uploads" }).ensureDir("locked/child");
      expectOperational(result, nativeCause, "EACCES", "mkdir");
      expect(await fs.readdir(parent)).toEqual([]);
    } finally {
      await fs.chmod(parent, 0o700);
    }
  });
});

describe("root directory policy results", () => {
  const policyFailure = { ok: false, error: "Invalid path: must stay within uploads" };

  it("rejects traversal, root aliases, escaping defaults and NUL before I/O", async () => {
    const rootDir = await tempRoot("fs-safe-dir-input-");
    const lstat = vi.spyOn(fs, "lstat");
    const mkdir = vi.spyOn(fs, "mkdir");
    for (const params of [
      { requestedPath: "../outside" },
      { requestedPath: path.join(rootDir, "..", "outside") },
      { requestedPath: "." },
      { requestedPath: " ", defaultDirName: "../outside" },
      { requestedPath: " ", defaultDirName: path.dirname(rootDir) },
      { requestedPath: "parent/child\0" },
      { requestedPath: "invalid\0/../child" },
      { requestedPath: " ", defaultDirName: "child\0" },
      { requestedPath: "child", rootDir: `${rootDir}\0` },
    ]) {
      await expect(ensureDirectoryWithinRoot({ rootDir, scopeLabel: "uploads", ...params }))
        .resolves.toEqual(policyFailure);
    }
    expect(lstat).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    await expect(pathScope(rootDir, { label: "uploads" }).ensureDir(" "))
      .resolves.toEqual({ ok: false, error: "path is required" });
  });

  it("keeps non-directories as policy failures", async () => {
    const rootDir = await tempRoot("fs-safe-dir-file-");
    const file = path.join(rootDir, "file");
    await fs.writeFile(file, "unchanged");
    const mkdir = vi.spyOn(fs, "mkdir");
    for (const [root, requestedPath] of [[rootDir, "file/child"], [file, "child"]] as const) {
      await expect(pathScope(root, { label: "uploads" }).ensureDir(requestedPath))
        .resolves.toEqual(policyFailure);
    }
    expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.readFile(file, "utf8")).toBe("unchanged");
  });

  itPosix("keeps a native ENOTDIR root lookup as a policy failure", async () => {
    const rootDir = await tempRoot("fs-safe-dir-notdir-");
    await fs.writeFile(path.join(rootDir, "file"), "unchanged");
    const root = path.join(rootDir, "file", "sub");
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOTDIR" });
    const mkdir = vi.spyOn(fs, "mkdir");
    await expect(pathScope(root, { label: "uploads" }).ensureDir("child"))
      .resolves.toEqual(policyFailure);
    expect(mkdir).not.toHaveBeenCalled();
  });

  itPosix("rejects root, in-root and outside symlinks without writes", async () => {
    const container = await tempRoot("fs-safe-dir-link-");
    const rootDir = path.join(container, "root");
    const outside = path.join(container, "outside");
    const inside = path.join(rootDir, "inside");
    await fs.mkdir(inside, { recursive: true });
    await fs.mkdir(outside);
    const rootAlias = path.join(container, "alias");
    await fs.symlink(rootDir, rootAlias, "dir");
    await fs.symlink(inside, path.join(rootDir, "inside-link"), "dir");
    await fs.symlink(outside, path.join(rootDir, "outside-link"), "dir");
    const mkdir = vi.spyOn(fs, "mkdir");
    for (const [root, requestedPath] of [
      [rootAlias, "child"], [rootDir, "inside-link/child"], [rootDir, "outside-link/child"],
    ] as const) {
      await expect(pathScope(root, { label: "uploads" }).ensureDir(requestedPath))
        .resolves.toEqual(policyFailure);
    }
    expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.readdir(inside)).toEqual([]);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  itDarwin("still accepts a real root beneath the macOS /tmp ancestor alias", async () => {
    const rootDir = await fs.mkdtemp("/tmp/fs-safe-dir-alias-");
    tempDirs.push(rootDir);
    await expect(pathScope(rootDir, { label: "uploads" }).ensureDir("child"))
      .resolves.toEqual({ ok: true, path: path.join(rootDir, "child") });
  });

  itPosix.each(["file", "symlink"] as const)("rejects an EEXIST race won by a %s", async (kind) => {
    const rootDir = await tempRoot("fs-safe-dir-race-");
    const outside = await tempRoot("fs-safe-dir-race-outside-");
    const target = path.join(rootDir, "raced");
    const realMkdir = fs.mkdir.bind(fs);
    const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
      if (String(candidate) !== target) return await realMkdir(candidate, options);
      if (kind === "file") await fs.writeFile(target, "racer");
      else await fs.symlink(outside, target, "dir");
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });
    await expect(pathScope(rootDir, { label: "uploads" }).ensureDir("raced/child"))
      .resolves.toEqual(policyFailure);
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each([
    ["nearest ancestor", "root", 2, false],
    ["segment", "child", 1, true],
    ["final", "child", 2, true],
  ] as const)("rejects an outside canonical path at the %s check", async (_stage, location, occurrence, created) => {
    const rootDir = await tempRoot("fs-safe-dir-canonical-");
    const outside = await tempRoot("fs-safe-dir-canonical-outside-");
    const candidatePath = location === "root" ? rootDir : path.join(rootDir, "child");
    const realRealpath = fs.realpath.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate, options) => {
      if (String(candidate) === candidatePath && ++calls === occurrence) return outside;
      return await realRealpath(candidate, options);
    });
    await expect(pathScope(rootDir, { label: "uploads" }).ensureDir("child"))
      .resolves.toEqual(policyFailure);
    expect(calls).toBe(occurrence);
    expect(await fs.readdir(rootDir)).toEqual(created ? ["child"] : []);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
