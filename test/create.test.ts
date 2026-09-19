import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDirectory, createDirectorySync, createDirectoryWithAdmission, createFileHandle, createFileSync } from "../src/create.js";
import { assertPrivateDirectory, assertPrivateDirectorySync } from "../src/creation-permissions.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { readWindowsSecurityFactsCommand } from "../src/windows-security-command.js";
import { hasPrivateCreationNative } from "./helpers/private-creation-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const tempDirs = useTempDirs();
const privateCreationAvailable = process.platform !== "darwin" || hasPrivateCreationNative();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe("exclusive leaf creation", () => {
  it("creates only the requested directory and refuses every existing entry", async () => {
    const base = await tempDirs.tempRoot("fs-safe-create-");
    for (const sync of [false, true]) {
      const create = (target: string) => sync ? Promise.resolve().then(() => createDirectorySync(target)) : createDirectory(target);
      const target = path.join(base, sync ? "sync" : "async");
      await create(target);
      expect(fs.statSync(target).isDirectory()).toBe(true);
      await expect(create(target)).rejects.toMatchObject({ code: "already-exists" });
      const file = path.join(base, sync ? "sync-file" : "async-file");
      fs.writeFileSync(file, "keep");
      await expect(create(file)).rejects.toMatchObject({ code: "already-exists" });
      expect(fs.readFileSync(file, "utf8")).toBe("keep");
      await expect(create(path.join(base, "missing", "child"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(fs.existsSync(path.join(base, "missing"))).toBe(false);
    }
  });

  it("returns one owned read/write descriptor and never truncates a collision", async () => {
    const base = await tempDirs.tempRoot("fs-safe-create-");
    const target = path.join(base, "file");
    const created = createFileSync(target);
    try {
      fs.writeSync(created.fd, "created");
      expect(fs.readFileSync(target, "utf8")).toBe("created");
      expect(() => createFileSync(target)).toThrow(expect.objectContaining({ code: "already-exists" }));
      const opened = fs.fstatSync(created.fd, { bigint: true });
      expect(fs.statSync(target, { bigint: true }).ino).toBe(opened.ino);
    } finally { created.close(); }
    created[Symbol.dispose]();
    expect(() => fs.fstatSync(created.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(fs.readFileSync(target, "utf8")).toBe("created");
  });

  it("does not create through a replaced admitted parent or an expired authority", async () => {
    const base = await tempDirs.tempRoot("fs-safe-create-");
    const parent = path.join(base, "parent");
    fs.mkdirSync(parent);
    const expected = fs.statSync(parent, { bigint: true });
    fs.renameSync(parent, path.join(base, "original"));
    fs.mkdirSync(parent);
    await expect(createDirectoryWithAdmission(path.join(parent, "child"), {}, {
      expectedParentIdentity: expected,
    })).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(createFileHandle(path.join(parent, "file"), {}, {
      expectedParentIdentity: expected,
    })).rejects.toMatchObject({ code: "path-mismatch" });
    const refusal = new Error("closed owner");
    expect(() => createFileSync(path.join(parent, "refused"), {
      assertBeforeMutation: () => { throw refusal; },
    })).toThrow(refusal);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("rechecks the parent after the synchronous authority callback", async () => {
    const base = await tempDirs.tempRoot("fs-safe-create-");
    const parent = path.join(base, "parent");
    fs.mkdirSync(parent);
    expect(() => createDirectorySync(path.join(parent, "child"), {
      assertBeforeMutation: () => {
        fs.renameSync(parent, path.join(base, "original"));
        fs.mkdirSync(parent);
      },
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(fs.readdirSync(path.join(base, "original"))).toEqual([]);
  });

  it.each([
    { private: true, mode: 0o755 },
    { private: true, mode: 0o4600 },
    { private: "yes" as unknown as boolean },
    { mode: -1 },
  ])("rejects invalid permission requests before touching disk: %j", async options => {
    const base = await tempDirs.tempRoot("fs-safe-create-");
    expect(() => createDirectorySync(path.join(base, "dir"), options)).toThrow();
    expect(() => createFileSync(path.join(base, "file"), options)).toThrow();
    expect(fs.readdirSync(base)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32" || !privateCreationAvailable)("POSIX private creation", () => {
  beforeEach(() => {
    if (process.platform === "darwin") configureFsSafeNative({ mode: "auto" });
  });

  it("creates private directories and validates existing privacy without repairing it", async () => {
    const base = await tempDirs.tempRoot("fs-safe-create-");
    const target = path.join(base, "private");
    await createDirectory(target, { private: true });
    expect(fs.statSync(target).mode & 0o777).toBe(0o700 & ~process.umask());
    await assertPrivateDirectory(target);
    fs.chmodSync(target, 0o755);
    expect(() => assertPrivateDirectorySync(target)).toThrow(expect.objectContaining({ code: "insecure-permissions" }));
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("keeps restrictive owner-only modes and returns a usable async creation handle", async () => {
    const base = await tempDirs.tempRoot("fs-safe-create-");
    const target = path.join(base, "readonly");
    const file = await createFileHandle(target, { private: true, mode: 0o400 });
    try {
      await file.writeFile("private payload");
      expect(fs.statSync(target).mode & 0o777).toBe(0o400 & ~process.umask());
      expect(fs.readFileSync(target, "utf8")).toBe("private payload");
    } finally { await file.close(); }
  });
});

describe.runIf(process.platform === "win32")("Windows private creation without the addon", () => {
  it("keeps the created inode pinned, publishes a protected ACL, and removes the private stage", async () => {
    configureFsSafeNative({ mode: "off" });
    const base = await tempDirs.tempRoot("fs-safe-create-");
    const target = path.join(base, "private-file");
    const file = createFileSync(target, { private: true });
    try {
      fs.writeSync(file.fd, "private payload");
      const facts = readWindowsSecurityFactsCommand(target);
      expect(facts).toMatchObject({
        ownerSid: facts.currentUserSid, daclProtected: true,
        worldReadable: false, worldWritable: false, groupReadable: false, groupWritable: false,
      });
      expect(fs.fstatSync(file.fd).nlink).toBe(1);
      expect(fs.readdirSync(base)).toEqual(["private-file"]);
      expect(() => createFileSync(target, { private: true })).toThrow(expect.objectContaining({ code: "already-exists" }));
      expect(fs.readFileSync(target, "utf8")).toBe("private payload");
    } finally { file.close(); }
    const handle = await createFileHandle(path.join(base, "async-file"), { private: true, mode: 0o400 });
    try { await handle.writeFile("held writable descriptor"); }
    finally { await handle.close(); }
    expect(await fsAsync.readFile(path.join(base, "async-file"), "utf8")).toBe("held writable descriptor");
  }, 120_000);
});
