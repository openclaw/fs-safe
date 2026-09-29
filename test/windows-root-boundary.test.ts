import { spawnSync } from "node:child_process";
import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { realpathSync } from "../src/realpath.js";
import { admitPathInsideRoot } from "../src/root-boundary.js";
import { root as openRoot } from "../src/root.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

function directoryStat(dev: bigint, ino: bigint): BigIntStats {
  return {
    dev,
    ino,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  } as BigIntStats;
}

describe("Windows Root prefix admission", () => {
  it.each([
    ["C:\\Trusted\\Root", "C:\\Trusted\\Root\\child", "C:\\Trusted\\Root\\child"],
    ["C:\\Trusted\\Root", "\\\\?\\C:\\Trusted\\Root\\child", "C:\\Trusted\\Root\\child"],
    ["\\\\server\\share\\Root", "\\\\?\\UNC\\server\\share\\Root\\child", "\\\\server\\share\\Root\\child"],
    ["//server/share/Root", "//server/share/Root/child", "\\\\server\\share\\Root\\child"],
    ["/\\server/share/Root", "/\\server/share/Root/child", "\\\\server\\share\\Root\\child"],
    ["//?/C:/Trusted/Root", "\\\\?\\C:\\Trusted\\Root\\child", "\\\\?\\C:\\Trusted\\Root\\child"],
    [
      "//?/UNC/server/share/Root",
      "\\\\?\\UNC\\server\\share\\Root\\child",
      "\\\\?\\UNC\\server\\share\\Root\\child",
    ],
  ])("adds no observation for an exact structural prefix: %s", (rootPath, candidatePath, expected) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(() => {
      throw new Error("exact admission must not observe the filesystem");
    });
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw new Error("exact admission must not canonicalize the prefix");
    });

    expect(admitPathInsideRoot({
      rootPath,
      candidatePath,
      rootIdentity: { dev: 11n, ino: 22n },
    })).toEqual({ admission: "exact", path: expected, relativePath: "child" });
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it("admits a case-fold-only prefix by exact identity and rebases its spelling", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const observed: string[] = [];
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((candidate) => {
      observed.push(String(candidate));
      return directoryStat(11n, 22n);
    }) as typeof fsSync.lstatSync);

    expect(admitPathInsideRoot({
      rootPath: "C:\\Trusted\\Root",
      candidatePath: "c:\\trusted\\root\\Child.txt",
      rootIdentity: { dev: 11n, ino: 22n },
    })).toEqual({
      admission: "identity",
      path: "C:\\Trusted\\Root\\Child.txt",
      relativePath: "Child.txt",
    });
    expect(observed).toEqual(["c:\\trusted\\root"]);
  });

  it("delegates case-fold-only identity inspection to the scoped adapter", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const nativeLstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(() => {
      throw new Error("scoped admission must not use the native adapter");
    });
    const inspectCandidateRoot = vi.fn();

    expect(admitPathInsideRoot({
      rootPath: "C:\\Trusted\\Root",
      candidatePath: "c:\\trusted\\root\\Child.txt",
      rootIdentity: { dev: 11n, ino: 22n },
      inspectCandidateRoot,
    })).toEqual({
      admission: "identity",
      path: "C:\\Trusted\\Root\\Child.txt",
      relativePath: "Child.txt",
    });
    expect(inspectCandidateRoot).toHaveBeenCalledWith(
      "c:\\trusted\\root",
      { dev: 11n, ino: 22n },
    );
    expect(nativeLstat).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "extended drive candidate",
      rootPath: "C:\\Trusted\\Root", candidatePath: "\\\\?\\c:\\trusted\\root\\Child.txt",
      inspectedRoot: "\\\\?\\c:\\trusted\\root", expectedPath: "C:\\Trusted\\Root\\Child.txt", relativePath: "Child.txt",
    },
    {
      name: "ordinary candidate under an extended drive root",
      rootPath: "\\\\?\\C:\\Trusted\\Root", candidatePath: "c:\\trusted\\root\\Child.txt",
      inspectedRoot: "c:\\trusted\\root", expectedPath: "\\\\?\\C:\\Trusted\\Root\\Child.txt", relativePath: "Child.txt",
    },
    {
      name: "extended UNC candidate with mixed marker casing",
      rootPath: "\\\\Server\\Share\\Root", candidatePath: "\\\\?\\uNc\\server\\share\\root\\Child.txt",
      inspectedRoot: "\\\\?\\uNc\\server\\share\\root", expectedPath: "\\\\Server\\Share\\Root\\Child.txt", relativePath: "Child.txt",
    },
    {
      name: "ordinary candidate under an extended UNC root",
      rootPath: "\\\\?\\UNC\\Server\\Share\\Root", candidatePath: "\\\\server\\share\\root\\Child.txt",
      inspectedRoot: "\\\\server\\share\\root", expectedPath: "\\\\?\\UNC\\Server\\Share\\Root\\Child.txt", relativePath: "Child.txt",
    },
    {
      name: "forward slashes and repeated boundary separators",
      rootPath: "C:/Trusted/Root///", candidatePath: "//?/c:/trusted/root///Child.txt",
      inspectedRoot: "\\\\?\\c:\\trusted\\root", expectedPath: "C:\\Trusted\\Root\\Child.txt", relativePath: "Child.txt",
    },
    {
      name: "root-only extended UNC candidate",
      rootPath: "\\\\Server\\Share\\Root", candidatePath: "\\\\?\\unc\\server\\share\\root",
      inspectedRoot: "\\\\?\\unc\\server\\share\\root", expectedPath: "\\\\Server\\Share\\Root", relativePath: "",
    },
    {
      name: "Unicode root with lowercase expansion and a surrogate pair",
      rootPath: "C:\\Rİ😀", candidatePath: "\\\\?\\c:\\rİ😀\\Child.txt",
      inspectedRoot: "\\\\?\\c:\\rİ😀", expectedPath: "C:\\Rİ😀\\Child.txt", relativePath: "Child.txt",
    },
    {
      name: "root-only case fold with different code-unit lengths",
      rootPath: "C:\\İ", candidatePath: "\\\\?\\c:\\i\u0307",
      inspectedRoot: "\\\\?\\c:\\i\u0307", expectedPath: "C:\\İ", relativePath: "",
    },
  ])("preserves the scoped inspector spelling for $name", ({ rootPath, candidatePath, inspectedRoot, expectedPath, relativePath }) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(() => {
      throw new Error("scoped inspection must not use the default filesystem adapter");
    });
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw new Error("unrequested canonicalization must not change the supplied root spelling");
    });
    const inspectCandidateRoot = vi.fn();

    expect(admitPathInsideRoot({
      rootPath, candidatePath, rootIdentity: { dev: 11n, ino: 22n }, inspectCandidateRoot,
    })).toEqual({ admission: "identity", path: expectedPath, relativePath });
    expect(inspectCandidateRoot).toHaveBeenCalledExactlyOnceWith(inspectedRoot, { dev: 11n, ino: 22n });
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it.each([
    ["C:\\Trusted\\Root", "\\\\?\\c:\\trusted\\root-adjacent\\child"],
    ["\\\\Server\\Share\\Root", "\\\\?\\UNC\\server\\share\\root-adjacent\\child"],
    ["C:\\Trusted\\Root", "\\\\?\\c:\\trusted\\\\root\\child"],
  ])("rejects a nonmatching supplied prefix without identity admission: %s → %s", (rootPath, candidatePath) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const inspectCandidateRoot = vi.fn();
    expect(admitPathInsideRoot({
      rootPath, candidatePath, rootIdentity: { dev: 11n, ino: 22n }, inspectCandidateRoot,
    })).toBeUndefined();
    expect(inspectCandidateRoot).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps the supplied namespaced root as the identity-cache key (same directory: %s)", sameDirectory => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const identityCache = new Map<string, boolean>();
    const inspectCandidateRoot = vi.fn(() => {
      if (!sameDirectory) throw new FsSafeError("path-mismatch", "different directory object");
    });
    const params = {
      rootPath: "\\\\Server\\Share\\Root", rootIdentity: { dev: 11n, ino: 22n }, identityCache, inspectCandidateRoot,
    };
    const first = admitPathInsideRoot({ ...params, candidatePath: "\\\\?\\uNc\\server\\share\\root\\First.txt" });
    expect(first).toEqual(sameDirectory
      ? { admission: "identity", path: "\\\\Server\\Share\\Root\\First.txt", relativePath: "First.txt" }
      : undefined);
    expect(inspectCandidateRoot).toHaveBeenCalledExactlyOnceWith(
      "\\\\?\\uNc\\server\\share\\root", { dev: 11n, ino: 22n },
    );
    expect([...identityCache]).toEqual([["\\\\?\\uNc\\server\\share\\root", sameDirectory]]);

    const second = admitPathInsideRoot({ ...params, candidatePath: "\\\\?\\uNc\\server\\share\\root\\Second.txt" });
    expect(second).toEqual(sameDirectory
      ? { admission: "identity", path: "\\\\Server\\Share\\Root\\Second.txt", relativePath: "Second.txt" }
      : undefined);
    expect(inspectCandidateRoot).toHaveBeenCalledTimes(1);
    expect([...identityCache]).toEqual([["\\\\?\\uNc\\server\\share\\root", sameDirectory]]);
  });

  it("canonicalizes the whole namespaced folded root before delegated identity inspection", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const realpath = vi.spyOn(realpathSync, "native").mockReturnValue("C:\\Canonical\\Root");
    const inspectCandidateRoot = vi.fn();

    expect(admitPathInsideRoot({
      rootPath: "C:\\Configured\\Alias", candidatePath: "\\\\?\\c:\\configured\\alias\\Child.txt",
      rootIdentity: { dev: 11n, ino: 22n }, resolveCandidateRoot: true, inspectCandidateRoot,
    })).toEqual({ admission: "identity", path: "C:\\Configured\\Alias\\Child.txt", relativePath: "Child.txt" });
    expect(realpath).toHaveBeenCalledExactlyOnceWith("\\\\?\\c:\\configured\\alias");
    expect(inspectCandidateRoot).toHaveBeenCalledExactlyOnceWith("C:\\Canonical\\Root", { dev: 11n, ino: 22n });
  });

  it.each(["different", "missing", "unknown"] as const)(
    "rejects a %s case-fold-only prefix with bounded observations",
    (scenario) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((() => {
        if (scenario === "missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return scenario === "different" ? directoryStat(11n, 23n) : directoryStat(0n, 0n);
      }) as typeof fsSync.lstatSync);

      expect(admitPathInsideRoot({
        rootPath: "C:\\Trusted\\Root",
        candidatePath: "C:\\Trusted\\root\\outside.txt",
        rootIdentity: { dev: 11n, ino: 22n },
      })).toBeUndefined();
      expect(lstat).toHaveBeenCalledTimes(scenario === "unknown" ? 2 : 1);
    },
  );

  it("resolves only a configured case-folded Root alias and still returns the trusted suffix", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const realpath = vi.spyOn(realpathSync, "native").mockReturnValue("C:\\Canonical\\Root");
    vi.spyOn(fsSync, "lstatSync").mockImplementation((() =>
      directoryStat(11n, 22n)) as typeof fsSync.lstatSync);

    expect(admitPathInsideRoot({
      rootPath: "C:\\Configured\\Alias",
      candidatePath: "c:\\configured\\alias\\child",
      rootIdentity: { dev: 11n, ino: 22n },
      resolveCandidateRoot: true,
    })).toEqual({
      admission: "identity",
      path: "C:\\Configured\\Alias\\child",
      relativePath: "child",
    });
    expect(realpath).toHaveBeenCalledWith("c:\\configured\\alias");
  });
});

describe.skipIf(path.sep !== "/")("POSIX Root admission while Windows is spoofed", () => {
  it("retains an exact POSIX child spelling", () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    expect(admitPathInsideRoot({
      rootPath: "/srv/trusted",
      candidatePath: "/srv/trusted/child",
    })).toEqual({
      admission: "exact",
      path: "/srv/trusted/child",
      relativePath: "child",
    });
  });

  it("rejects a case-distinct POSIX sibling", () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    expect(admitPathInsideRoot({
      rootPath: "/srv/Root",
      candidatePath: "/srv/root/child",
    })).toBeUndefined();
  });

  it("rejects an adjacent POSIX prefix", () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    expect(admitPathInsideRoot({
      rootPath: "/srv/root",
      candidatePath: "/srv/root-adjacent/child",
    })).toBeUndefined();
  });

  it("admits descendants of the POSIX filesystem root", () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    expect(admitPathInsideRoot({
      rootPath: "/",
      candidatePath: "/srv/trusted/child",
    })).toEqual({
      admission: "exact",
      path: "/srv/trusted/child",
      relativePath: "srv/trusted/child",
    });
  });
});

function alternateBasenameCase(value: string): string {
  const parent = path.dirname(value);
  const basename = path.basename(value);
  const index = [...basename].findIndex(character => /[a-z]/iu.test(character));
  if (index < 0) return value;
  const character = basename[index]!;
  const swapped = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
  return path.join(parent, `${basename.slice(0, index)}${swapped}${basename.slice(index + 1)}`);
}

describe.skipIf(process.platform !== "win32")("real Windows case-sensitive Root containment", () => {
  it("accepts alternate Root casing only when it is the same directory object", async (context) => {
    const rootDir = await tempRoot("fs-safe-windows-case-admission-");
    const alternateRoot = alternateBasenameCase(rootDir);
    if (alternateRoot === rootDir) {
      context.skip();
      return;
    }
    try {
      const expected = fsSync.lstatSync(rootDir, { bigint: true });
      const observed = fsSync.lstatSync(alternateRoot, { bigint: true });
      if (expected.dev !== observed.dev || expected.ino !== observed.ino) {
        context.skip();
        return;
      }
    } catch {
      context.skip();
      return;
    }
    await fs.writeFile(path.join(rootDir, "value.txt"), "inside");
    const scoped = await openRoot(rootDir);

    await expect(scoped.readAbsolute(path.join(alternateRoot, "value.txt"))).resolves.toMatchObject({
      buffer: Buffer.from("inside"),
    });
    await expect(scoped.resolve(path.join(alternateRoot, "value.txt"))).resolves.toBe(
      path.join(rootDir, "value.txt"),
    );
    await expect(scoped.stat(path.join(alternateRoot, "value.txt"))).resolves.toMatchObject({
      isFile: true,
    });
    await expect(scoped.list(alternateRoot)).resolves.toEqual(["value.txt"]);
  });

  it("rejects a case-folded sibling across reads, fallback writes, creates, and moves", async (context) => {
    const container = await tempRoot("fs-safe-windows-case-sensitive-");
    const enabled = spawnSync(
      resolveWindowsSystemCommand("fsutil.exe"),
      ["file", "setCaseSensitiveInfo", container, "enable"],
      { stdio: "ignore", timeout: 10_000, windowsHide: true },
    );
    if (enabled.error || enabled.status !== 0) {
      context.skip();
      return;
    }

    const trustedRoot = path.join(container, "Root");
    const foldedSibling = path.join(container, "root");
    await fs.mkdir(trustedRoot);
    await fs.mkdir(foldedSibling);
    await fs.mkdir(path.join(trustedRoot, "nested"));
    await fs.writeFile(path.join(trustedRoot, "source.txt"), "trusted-source");
    await fs.writeFile(path.join(trustedRoot, "move-source.txt"), "trusted-move-source");
    await fs.writeFile(path.join(foldedSibling, "outside.txt"), "outside");
    await fs.writeFile(path.join(foldedSibling, "move-source.txt"), "outside-source");
    await fs.symlink(foldedSibling, path.join(trustedRoot, "alias"), "junction");
    await fs.symlink(
      path.join(trustedRoot, "nested"),
      path.join(foldedSibling, "reenter"),
      "junction",
    );
    const scoped = await openRoot(trustedRoot, {
      durable: false,
      mkdir: false,
      renameIdentity: "verify-content-with-lock",
    });

    const outside = (name: string) => path.join(foldedSibling, name);
    const rejected: Array<[string, () => Promise<unknown>]> = [
      ["resolve", () => scoped.resolve(outside("resolve.txt"))],
      ["readAbsolute", () => scoped.readAbsolute(outside("outside.txt"))],
      ["stat", () => scoped.stat(outside("outside.txt"))],
      ["list", () => scoped.list(foldedSibling)],
      ["canonical symlink hop", () => scoped.readText("alias/outside.txt", { symlinks: "follow-within-root" })],
      ["openWritable", async () => { const opened = await scoped.openWritable(outside("open.txt")); await opened.handle.close(); }],
      ["append", () => scoped.append(outside("append.txt"), "changed")],
      ["write fallback", () => scoped.write(outside("write.txt"), "changed")],
      ["writeJson fallback", () => scoped.writeJson(outside("write.json"), { changed: true })],
      ["create fallback", () => scoped.create(outside("create.txt"), "changed")],
      ["createJson fallback", () => scoped.createJson(outside("create.json"), { changed: true })],
      ["move source", () => scoped.move(outside("move-source.txt"), "moved-in.txt")],
      ["move raw re-entry source", () => scoped.move(
        `${foldedSibling}${path.sep}reenter${path.sep}..${path.sep}move-source.txt`,
        "moved-in.txt",
      )],
      ["move destination", () => scoped.move("source.txt", outside("moved-out.txt"))],
    ];
    for (const [label, operation] of rejected) {
      await expect(operation(), label).rejects.toBeInstanceOf(FsSafeError);
    }

    await expect(fs.readFile(path.join(foldedSibling, "outside.txt"), "utf8")).resolves.toBe("outside");
    await expect(fs.readFile(path.join(foldedSibling, "move-source.txt"), "utf8")).resolves.toBe("outside-source");
    await expect(fs.readFile(path.join(trustedRoot, "move-source.txt"), "utf8")).resolves.toBe("trusted-move-source");
    await expect(fs.readFile(path.join(trustedRoot, "source.txt"), "utf8")).resolves.toBe("trusted-source");
    for (const name of [
      "resolve.txt", "open.txt", "append.txt", "write.txt", "write.json", "create.txt",
      "create.json", "moved-out.txt",
    ]) {
      await expect(fs.lstat(outside(name)), name).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.lstat(path.join(trustedRoot, "moved-in.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
