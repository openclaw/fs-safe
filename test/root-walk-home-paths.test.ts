import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.unstubAllEnvs();
  configureFsSafeNative({ mode: "auto" });
});
const directoryLink = process.platform === "win32" ? "junction" : "dir";
async function write(file: string, content = "fixture") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

describe.each(["sorted", "filesystem"] as const)("Root walk caller home paths, %s", order => {
  it.each([false, true])("admits HOME independently from a literal mirror=%s", async mirror => {
    const directory = await tempRoot("fs-safe-walk-home-");
    const home = path.join(directory, "home");
    await write(path.join(home, "top.txt"));
    await write(path.join(home, "dir", "deep", "home.txt"));
    await write(path.join(home, "~", "nested", "literal-child.txt"));
    if (mirror) {
      await write(path.join(directory, "~", "top.txt"), "decoy");
      await write(path.join(directory, "~", "dir", "deep", "decoy.txt"));
    }
    vi.stubEnv("HOME", home);
    const scoped = await root(directory);
    const options = { order, symlinkPolicy: "skip" as const };
    const files = async (input: string) => (await Array.fromAsync(scoped.walk(input, options)))
      .filter(entry => entry.kind === "file").map(entry => entry.relativePath).sort();
    expect(await files("~")).toEqual(["home/dir/deep/home.txt", "home/top.txt", "home/~/nested/literal-child.txt"]);
    expect(await files("~/dir")).toEqual(["home/dir/deep/home.txt"]);
    if (mirror) expect(await files("./~/dir")).toEqual(["~/dir/deep/decoy.txt"]);
    else await expect(files("./~/dir")).rejects.toMatchObject({ code: "not-file" });
  });

  it("uses an empty Root-relative prefix when HOME is the Root", async () => {
    const directory = await tempRoot("fs-safe-walk-home-root-");
    await write(path.join(directory, "dir", "entry"));
    await write(path.join(directory, "~", "literal"));
    vi.stubEnv("HOME", directory);
    const scoped = await root(directory);
    const entries = await Array.fromAsync(scoped.walk("~", { order, symlinkPolicy: "skip" }));
    expect(entries.map(entry => entry.relativePath).sort()).toEqual(["dir", "dir/entry", "~", "~/literal"]);
  });

  it("preserves a non-home caller's start alias spelling", async () => {
    const directory = await tempRoot("fs-safe-walk-home-alias-");
    const home = path.join(directory, "home");
    await write(path.join(home, "dir", "deep", "entry"));
    await fs.symlink(path.join(home, "dir"), path.join(directory, "alias"), directoryLink);
    vi.stubEnv("HOME", home);
    const scoped = await root(directory);
    for (const symlinkPolicy of ["skip", "follow-within-root"] as const) {
      const entries = await Array.fromAsync(scoped.walk("alias", { order, symlinkPolicy }));
      expect(entries.map(entry => entry.relativePath)).toEqual(["alias/deep", "alias/deep/entry"]);
    }
  });

  it("reports an admitted HOME suffix alias by its canonical Root-relative target", async () => {
    const directory = await tempRoot("fs-safe-walk-home-suffix-alias-");
    const home = path.join(directory, "home");
    await fs.mkdir(home);
    await fs.mkdir(path.join(directory, "~"));
    await write(path.join(directory, "target", "deep", "entry"));
    await write(path.join(directory, "decoy", "wrong"));
    await fs.symlink(path.join(directory, "target"), path.join(home, "link"), directoryLink);
    await fs.symlink(path.join(directory, "decoy"), path.join(directory, "~", "link"), directoryLink);
    vi.stubEnv("HOME", home);
    const scoped = await root(directory);
    for (const symlinkPolicy of ["skip", "follow-within-root"] as const) {
      const options = { order, symlinkPolicy };
      const expanded = await Array.fromAsync(scoped.walk("~/link", options));
      expect(expanded.map(entry => entry.relativePath)).toEqual(["target/deep", "target/deep/entry"]);
      const ordinary = await Array.fromAsync(scoped.walk("home/link", options));
      expect(ordinary.map(entry => entry.relativePath)).toEqual(["home/link/deep", "home/link/deep/entry"]);
    }
  });

  it("captures HOME and admits directories only when iteration starts", async () => {
    const directory = await tempRoot("fs-safe-walk-home-lazy-");
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    await write(path.join(first, "dir", "old"));
    await write(path.join(second, "dir", "deep", "current"));
    vi.stubEnv("HOME", first);
    const scoped = await root(directory);
    const iterator = scoped.walk("~/dir", { order, symlinkPolicy: "skip" });
    vi.stubEnv("HOME", second);
    const entry = await iterator.next();
    expect(entry.value).toMatchObject({ relativePath: "second/dir/deep", kind: "directory" });
    vi.stubEnv("HOME", first);
    expect((await Array.fromAsync(iterator)).map(value => value.relativePath)).toEqual(["second/dir/deep/current"]);
    const late = scoped.walk("not-yet", { order, symlinkPolicy: "skip" });
    await write(path.join(directory, "not-yet", "created-after-iterator"));
    expect((await Array.fromAsync(late)).map(value => value.relativePath)).toEqual(["not-yet/created-after-iterator"]);
  });

  it("refuses outside HOME before quoting and retains the caller's error path", async () => {
    const container = await tempRoot("fs-safe-walk-home-outside-");
    const directory = path.join(container, "root");
    const outside = path.join(container, "outside");
    await write(path.join(directory, "~", "dir", "literal"));
    await write(path.join(outside, "dir", "private"));
    vi.stubEnv("HOME", outside);
    const scoped = await root(directory);
    const options = { order, symlinkPolicy: "skip" as const };
    await expect(Array.fromAsync(scoped.walk("~/dir", options))).rejects.toThrow(/^Path escapes root walk/);
    const entries = await Array.fromAsync(scoped.walk("~/dir", { ...options, onDirectoryError: "skip-and-report" }));
    expect(entries).toEqual([{ relativePath: "~/dir", kind: "directory-error", size: 0, error: expect.any(Error) }]);
    expect((await Array.fromAsync(scoped.walk("./~/dir", options))).map(entry => entry.relativePath)).toEqual(["~/dir/literal"]);
  });

  it("keeps invalid options lazy and prior to home admission", async () => {
    const directory = await tempRoot("fs-safe-walk-home-options-");
    vi.stubEnv("HOME", path.join(directory, "missing"));
    const scoped = await root(directory);
    const badPolicy = scoped.walk("~/dir", { order, symlinkPolicy: "invalid" as "skip", onDirectoryError: "skip-and-report" });
    await expect(badPolicy.next()).rejects.toThrow("invalid root walk symlink policy: invalid");
    const badBudget = scoped.walk("~/dir", { order, symlinkPolicy: "skip", maxEntries: -1, onDirectoryError: "skip-and-report" });
    await expect(badBudget.next()).rejects.toThrow("maxEntries must be a non-negative safe integer");
    const missing = await Array.fromAsync(scoped.walk("~/dir", { order, symlinkPolicy: "skip", onDirectoryError: "skip-and-report" }));
    expect(missing).toEqual([{ relativePath: "~/dir", kind: "directory-error", size: 0, error: expect.any(Error) }]);
  });
});
