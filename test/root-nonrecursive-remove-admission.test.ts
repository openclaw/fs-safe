import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { resolveRootContext } from "../src/root-context.js";
import { removePathInRootFallback } from "../src/root-remove.js";
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

it.each([
  { canonicalizations: 3, parentDepth: 0 },
  { canonicalizations: 6, parentDepth: 2 },
  { canonicalizations: 6, parentDepth: 8 },
])(
  "keeps nonrecursive parent admission linear at depth $parentDepth",
  async ({ canonicalizations, parentDepth }) => {
    const directory = await tempRoot("fs-safe-remove-parent-budget-");
    const context = await resolveRootContext(directory);
    const boundaries = [context.rootReal];
    let parent = context.rootReal;
    for (let index = 0; index < parentDepth; index += 1) {
      parent = path.join(parent, `level-${index}`);
      boundaries.push(parent);
    }
    await fs.mkdir(parent, { recursive: true });
    const candidate = path.join(parent, "candidate");
    await fs.writeFile(candidate, "value");

    const boundarySet = new Set(boundaries);
    const identityObservations = new Map(boundaries.map(boundary => [boundary, 0]));
    const canonicalPaths: string[] = [];
    const lstat = fsSync.lstatSync.bind(fsSync);
    const canonicalize = realpathSync.native;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const observed = String(args[0]);
      const options = args[1] as { bigint?: boolean } | undefined;
      if (options?.bigint === true && boundarySet.has(observed)) {
        identityObservations.set(observed, identityObservations.get(observed)! + 1);
      }
      return lstat(...args);
    }) as typeof fsSync.lstatSync);
    vi.spyOn(realpathSync, "native").mockImplementation(observed => {
      const candidatePath = String(observed);
      if (boundarySet.has(candidatePath)) canonicalPaths.push(candidatePath);
      return canonicalize(observed);
    });

    await removePathInRootFallback(context, candidate, {});

    expect(canonicalPaths).toHaveLength(canonicalizations);
    expect(new Set(canonicalPaths)).toEqual(
      new Set(parentDepth === 0 ? [context.rootReal] : [context.rootReal, parent]),
    );
    for (const observations of identityObservations.values()) {
      // Unknown Windows identities may take the one bounded retry provided by
      // the strict identity observer, but work still grows only with depth.
      expect(observations).toBeGreaterThanOrEqual(3);
      expect(observations).toBeLessThanOrEqual(6);
    }
  },
);
