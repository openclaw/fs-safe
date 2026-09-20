import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMutationNotDenied, type DenyMutationPolicy } from "../src/deny-mutations.js";
import { assertFileLockSyncRootMutationAllowed } from "../src/file-lock-sync-root.js";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const routes = [
  {
    name: "Root",
    assert: async (target: string, policy: DenyMutationPolicy, protectAncestors = false) =>
      assertMutationNotDenied(target, policy, { protectAncestors }),
  },
  {
    name: "synchronous Root lock",
    assert: async (target: string, policy: DenyMutationPolicy, protectAncestors = false) =>
      assertFileLockSyncRootMutationAllowed(target, policy, protectAncestors),
  },
];

afterEach(() => vi.restoreAllMocks());

describe.each(routes)("$name deny policy decisions", ({ assert }) => {
  it("keeps exact entries, descendant prefixes, and protected ancestors distinct", async () => {
    const directory = await tempRoot("fs-safe-deny-relations-");
    const selected = path.join(directory, "selected");
    const descendant = path.join(selected, "child");

    await expect(assert(selected, { paths: [selected] })).rejects.toMatchObject({ code: "denied-path" });
    await expect(assert(descendant, { paths: [selected] })).resolves.toBeUndefined();
    for (const target of [selected, descendant]) {
      await expect(assert(target, { prefixes: [selected] })).rejects.toMatchObject({ code: "denied-path" });
    }
    for (const policy of [{ paths: [selected] }, { prefixes: [selected] }]) {
      await expect(assert(directory, policy)).resolves.toBeUndefined();
      await expect(assert(directory, policy, true)).rejects.toMatchObject({ code: "denied-path" });
    }
  });

  it("does not read the prefix phase after an exact denial", async () => {
    const directory = await tempRoot("fs-safe-deny-lazy-prefix-");
    const target = path.join(directory, "selected");
    const failure = new Error("prefix policy must remain unread");
    const policy = {
      paths: [target],
      get prefixes(): readonly string[] { throw failure; },
    };

    await expect(assert(target, policy)).rejects.toMatchObject({ code: "denied-path" });
    await expect(assert(path.join(directory, "other"), policy)).rejects.toBe(failure);
  });

  it("validates the complete exact phase before comparing any of its paths", async () => {
    const directory = await tempRoot("fs-safe-deny-validation-order-");
    const target = path.join(directory, "selected");
    await expect(assert(target, { paths: [target, "relative"] }))
      .rejects.toMatchObject({ code: "invalid-path" });
    await expect(assert(target, { paths: [target], prefixes: ["relative"] }))
      .rejects.toMatchObject({ code: "denied-path" });
  });

  it.skipIf(process.platform === "win32")("denies missing descendants through a live symlink ancestor", async () => {
    const directory = await tempRoot("fs-safe-deny-ancestor-alias-");
    const protectedDirectory = path.join(directory, "protected");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(protectedDirectory);
    fs.symlinkSync(protectedDirectory, alias, "dir");

    await expect(assert(path.join(alias, "missing", "value"), { prefixes: [protectedDirectory] }))
      .rejects.toMatchObject({ code: "denied-path" });
  });
});

it("keeps synchronous Root-lock canonicalization failures distinct from Root lexical fallback", async () => {
  const directory = await tempRoot("fs-safe-deny-canonical-failure-");
  const target = path.join(directory, "missing", "selected");
  const failure = Object.assign(new Error("ancestor canonicalization denied"), { code: "EACCES" });
  vi.spyOn(realpathSync, "native").mockImplementation(() => { throw failure; });

  expect(() => assertMutationNotDenied(target, { paths: [target] }))
    .toThrow(expect.objectContaining({ code: "denied-path" }));
  expect(() => assertFileLockSyncRootMutationAllowed(target, { paths: [target] })).toThrow(failure);
});

it.each(["", "relative"])("preserves each route's validation error for %j", async (entry) => {
  const directory = await tempRoot("fs-safe-deny-error-label-");
  const target = path.join(directory, "selected");
  expect(() => assertMutationNotDenied(target, { paths: [entry] })).toThrow(expect.objectContaining({
    code: "invalid-path",
    message: entry === "" ? "deny mutation paths must be non-empty" : "deny mutation paths must be absolute",
  }));
  expect(() => assertFileLockSyncRootMutationAllowed(target, { paths: [entry] })).toThrow(
    "deny mutation paths must be non-empty absolute paths",
  );
});
