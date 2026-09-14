import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDirectoryIdentitySync, readDirectoryIdentity } from "../src/advanced.js";
import { configureFsSafeNative, getFsSafeNativeConfig } from "../src/config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const nativeConfig = getFsSafeNativeConfig();
const separators = process.platform === "win32" ? ["\\", "\\\\\\", "/", "///"] : ["/", "///"];

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative(nativeConfig);
});

async function actualDirectoryIdentity(directory: string) {
  const stat = await fs.lstat(directory, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, realPath: await fs.realpath(directory) };
}

describe.each(["read", "assert"] as const)("directory identity %s with trailing separators", operation => {
  it.each(separators)("rejects a final directory link followed by %j", async suffix => {
    const base = await tempRoot("fs-safe-directory-link-suffix-");
    const target = path.join(base, "target");
    const link = path.join(base, "link");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep"), "untouched");
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const expected = await actualDirectoryIdentity(target);

    await expect(async () => operation === "read"
      ? await readDirectoryIdentity(link + suffix)
      : assertDirectoryIdentitySync(link + suffix, expected))
      .rejects.toMatchObject({ code: "not-file" });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(target, "keep"), "utf8")).toBe("untouched");
  });
});

it("accepts ordinary directories with one or repeated trailing separators", async () => {
  const directory = await tempRoot("fs-safe-directory-suffix-");
  const expected = await actualDirectoryIdentity(directory);
  for (const suffix of separators) {
    await expect(readDirectoryIdentity(directory + suffix)).resolves.toEqual(expected);
    expect(assertDirectoryIdentitySync(directory + suffix, expected)).toBeUndefined();
  }
});

it("keeps the real filesystem or drive root valid with trailing separators", async () => {
  const root = path.parse(await fs.realpath(process.cwd())).root;
  const expected = await actualDirectoryIdentity(root);
  for (const suffix of ["", path.sep.repeat(2)]) {
    await expect(readDirectoryIdentity(root + suffix)).resolves.toEqual(expected);
    expect(assertDirectoryIdentitySync(root + suffix, expected)).toBeUndefined();
  }
});

it.skipIf(process.platform === "win32").each(["literal\\", " padded "])(
  "preserves the POSIX directory name %j",
  async name => {
    const base = await tempRoot("fs-safe-directory-literal-");
    const directory = path.join(base, name);
    await fs.mkdir(directory);
    await fs.mkdir(path.join(base, name === "literal\\" ? "literal" : "padded"));
    const expected = await actualDirectoryIdentity(directory);
    for (const suffix of ["", "/", "///"]) {
      await expect(readDirectoryIdentity(directory + suffix)).resolves.toEqual(expected);
      expect(assertDirectoryIdentitySync(directory + suffix, expected)).toBeUndefined();
    }
  },
);

it.skipIf(process.platform === "win32")("preserves raw parent-link traversal through '..'", async () => {
  const base = await tempRoot("fs-safe-directory-parent-traversal-");
  const physicalParent = path.join(base, "physical");
  const child = path.join(physicalParent, "child");
  const physicalTarget = path.join(physicalParent, "selected");
  const lexicalTarget = path.join(base, "selected");
  const alias = path.join(base, "alias");
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(physicalTarget);
  await fs.mkdir(lexicalTarget);
  await fs.symlink(child, alias, "dir");
  const expected = await actualDirectoryIdentity(physicalTarget);
  // path.join/resolve would erase traversal through the symlink before the OS sees it.
  const requested = `${alias}/../selected///`;
  expect(await fs.realpath(requested)).toBe(expected.realPath);
  expect(expected.realPath).not.toBe(await fs.realpath(lexicalTarget));

  await expect(readDirectoryIdentity(requested)).resolves.toEqual(expected);
  expect(assertDirectoryIdentitySync(requested, expected)).toBeUndefined();
});

describe("projected Windows root spelling compatibility", () => {
  it.each([
    { name: "drive", root: "C:\\", bareRoot: false },
    { name: "UNC share", root: "\\\\server\\share\\", bareRoot: true },
    { name: "extended drive", root: "\\\\?\\C:\\", bareRoot: false },
    { name: "extended UNC share", root: "\\\\?\\UNC\\server\\share\\", bareRoot: true },
  ])("preserves the $name root", async ({ root, bareRoot }) => {
    const directory = await tempRoot("fs-safe-directory-root-projection-");
    const identity = await actualDirectoryIdentity(directory);
    const expected = { ...identity, realPath: root };
    const spellings = new Set([root, root + "\\", root + "\\\\"]);
    if (bareRoot) spellings.add(root.slice(0, -1));
    const operationSpellings = new Set(spellings);
    if (/^\\\\[?.]\\[A-Za-z]:\\$/u.test(root)) operationSpellings.add(root.slice(4));
    Object.defineProperty(process, "platform", { value: "win32" });
    configureFsSafeNative({ mode: "off" });
    const lstat = fsSync.lstatSync.bind(fsSync);
    const assertRootSpelling = (observedPath: fsSync.PathLike) => {
      if (!operationSpellings.has(String(observedPath))) {
        throw Object.assign(new Error("invalid projected root spelling"), { code: "ENOENT" });
      }
    };
    // Only the filesystem boundary is projected; these cases do not contact a real UNC share.
    vi.spyOn(fsSync, "lstatSync").mockImplementation((observedPath, options) => {
      assertRootSpelling(observedPath);
      return lstat(directory, options);
    });
    vi.spyOn(fsSync.realpathSync, "native").mockImplementation((observedPath) => {
      assertRootSpelling(observedPath);
      return root;
    });

    for (const observedPath of spellings) {
      await expect(readDirectoryIdentity(observedPath)).resolves.toEqual(expected);
      expect(assertDirectoryIdentitySync(observedPath, expected)).toBeUndefined();
    }
  });
});
