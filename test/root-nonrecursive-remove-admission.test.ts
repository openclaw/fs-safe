import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["file", "directory"].flatMap(kind => [false, true].map(force => ({ force, kind }))))(
  "admits the nonrecursive $kind parent beneath Root before removal (force=$force)",
  async ({ force, kind }) => {
    const directory = await tempRoot("fs-safe-remove-parent-admission-");
    const outside = await tempRoot("fs-safe-remove-parent-admission-outside-");
    const scope = path.join(directory, "scope");
    const savedScope = path.join(directory, "saved-scope");
    const parent = path.join(scope, "parent");
    const candidate = path.join(parent, "candidate");
    const outsideParent = path.join(outside, "parent");
    const outsideCandidate = path.join(outsideParent, "candidate");
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(outsideParent, { recursive: true });
    if (kind === "file") {
      await fs.writeFile(candidate, "inside");
      await fs.writeFile(outsideCandidate, "outside");
    } else {
      await fs.mkdir(candidate);
      await fs.mkdir(outsideCandidate);
    }

    const scoped = await root(directory);
    const lstat = fsSync.lstatSync.bind(fsSync);
    let parentObservations = 0;
    let redirected = false;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      if (String(args[0]) === parent && ++parentObservations === 2) {
        fsSync.renameSync(scope, savedScope);
        fsSync.symlinkSync(outside, scope, process.platform === "win32" ? "junction" : "dir");
        redirected = true;
      }
      return lstat(...args);
    }) as typeof fsSync.lstatSync);

    await expect(scoped.remove("scope/parent/candidate", { force })).rejects.toMatchObject({
      code: "path-mismatch",
    });

    expect(redirected).toBe(true);
    expect((await fs.lstat(outsideCandidate)).isDirectory()).toBe(kind === "directory");
    expect((await fs.lstat(path.join(savedScope, "parent", "candidate"))).isDirectory()).toBe(kind === "directory");
    if (kind === "file") {
      expect(await fs.readFile(outsideCandidate, "utf8")).toBe("outside");
      expect(await fs.readFile(path.join(savedScope, "parent", "candidate"), "utf8")).toBe("inside");
    }
  },
);

it.each([
  { boundary: "immediate parent", expectedCode: "not-found" },
  { boundary: "intermediate ancestor", expectedCode: "path-mismatch" },
])("reports a disappeared $boundary after removal even with force", async ({ boundary, expectedCode }) => {
  const directory = await tempRoot("fs-safe-remove-parent-post-dispatch-");
  const ancestor = path.join(directory, "ancestor");
  const parent = path.join(ancestor, "parent");
  const candidate = path.join(parent, "candidate");
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(candidate, "value");
  const scoped = await root(directory);
  const unlink = fs.unlink.bind(fs);
  const removedBoundary = boundary === "immediate parent" ? parent : ancestor;
  const movedBoundary = path.join(directory, "moved-boundary");
  vi.spyOn(fs, "unlink").mockImplementationOnce(async target => {
    await unlink(target);
    await fs.rename(removedBoundary, movedBoundary);
  });

  await expect(scoped.remove("ancestor/parent/candidate", { force: true })).rejects.toMatchObject({
    code: expectedCode,
  });
  const movedCandidate = boundary === "immediate parent"
    ? path.join(movedBoundary, "candidate")
    : path.join(movedBoundary, "parent", "candidate");
  await expect(fs.lstat(movedCandidate)).rejects.toMatchObject({ code: "ENOENT" });
});
