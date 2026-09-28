import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMutationNotDenied } from "../src/deny-mutations.js";
import { assertFileLockSyncRootMutationAllowed } from "../src/file-lock-sync-root.js";
import * as caseProbe from "../src/path-case.js";
import * as suffixProbe from "../src/path-suffix-aliases.js";
import { realpathSync } from "../src/realpath.js";
import { root, type Root } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

const operations: Record<string, (safe: Root, target: string, source: string) => Promise<unknown>> = {
  create: (safe, target) => safe.create(target, "new"),
  write: (safe, target) => safe.write(target, "new"),
  append: (safe, target) => safe.append(target, "new"),
  mkdir: (safe, target) => safe.mkdir(target),
  copyIn: (safe, target, source) => safe.copyIn(target, source),
  move: (safe, target) => safe.move("source", target, { overwrite: true }),
  openWritable: async (safe, target) => { const opened = await safe.openWritable(target); await opened.handle.close(); },
};

for (const mode of ["auto", "off"] as const) {
  describe(`prospective deny aliases (${mode})`, () => {
    it.each(Object.entries(operations))("%s respects missing case variants on the live filesystem", async (_, run) => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-deny-case-");
      const source = path.join(directory, "source");
      fs.writeFileSync(source, "original");
      const insensitive = caseProbe.probePathCaseInsensitiveSync(path.join(directory, "Case.txt"), { allowTemporaryProbe: false });
      expect(insensitive).toBeTypeOf("boolean");
      const safe = await root(directory, { denyMutations: { paths: [path.join(directory, "Case.txt")] } });
      if (insensitive) {
        await expect(run(safe, "case.txt", source)).rejects.toMatchObject({ code: "denied-path" });
        expect(fs.readdirSync(directory)).toEqual(["source"]);
      } else {
        await run(safe, "case.txt", source);
        expect(fs.existsSync(path.join(directory, "case.txt"))).toBe(true);
        expect(fs.existsSync(path.join(directory, "Case.txt"))).toBe(false);
      }
    });

    it.each(Object.entries(operations))("%s fails closed for missing NFC/NFD variants", async (_, run) => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-deny-normalization-");
      const source = path.join(directory, "source");
      fs.writeFileSync(source, "original");
      const safe = await root(directory, { denyMutations: { paths: [path.join(directory, "caf\u00e9")] } });
      await expect(run(safe, "cafe\u0301", source)).rejects.toMatchObject({ code: "denied-path" });
      expect(fs.readdirSync(directory)).toEqual(["source"]);
    });

    it.each(["paths", "prefixes"] as const)("protects a missing aliased parent using %s", async (kind) => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-deny-parent-");
      const safe = await root(directory, { mkdir: true,
        denyMutations: { [kind]: [path.join(directory, "Caf\u00e9")] } });
      await expect(safe.create("cafe\u0301/child/value", "new")).rejects.toMatchObject({ code: "denied-path" });
      expect(fs.readdirSync(directory)).toEqual([]);
    });

    it("allows unrelated missing names and exact-policy descendants", async () => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-deny-distinct-");
      const safe = await root(directory, { denyMutations: { paths: [path.join(directory, "Case.txt")] } });
      await safe.create("other.txt", "allowed");
      await safe.create("Case.txt.backup", "allowed");
      expect(await safe.readText("other.txt")).toBe("allowed");
      expect(() => assertMutationNotDenied(path.join(directory, "case.txt", "child"), {
        paths: [path.join(directory, "Case.txt")],
      })).not.toThrow();
    });
  });
}

describe.each([
  ["Root", assertMutationNotDenied],
  ["synchronous Root lock", assertFileLockSyncRootMutationAllowed],
] as const)("%s conservative admission", (_, assert) => {
  it("does not create probes in an empty directory", async () => {
    const directory = await tempRoot("fs-safe-deny-empty-");
    const writable = vi.spyOn(suffixProbe, "probePathSuffixAliasesSync");
    const readOnly = vi.spyOn(caseProbe, "probePathCaseInsensitiveSync");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const open = vi.spyOn(fs, "openSync");
    expect(() => assert(path.join(directory, "case"), { paths: [path.join(directory, "Case")] }))
      .toThrow(expect.objectContaining({ code: "denied-path" }));
    expect(writable).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    for (const [, options] of readOnly.mock.calls) expect(options).toEqual({ allowTemporaryProbe: false });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each([true, undefined])("denies with case observation %s", async (answer) => {
    const directory = await tempRoot("fs-safe-deny-unknown-");
    vi.spyOn(caseProbe, "probePathCaseInsensitiveSync").mockReturnValue(answer);
    expect(() => assert(path.join(directory, "case"), { paths: [path.join(directory, "Case")] }))
      .toThrow(expect.objectContaining({ code: "denied-path" }));
  });
});

it.skipIf(process.platform === "win32")("bounds read-only probes per ancestor and skips unrelated and identical pairs", async () => {
  const directory = await tempRoot("fs-safe-deny-cache-");
  const probe = vi.spyOn(caseProbe, "probePathCaseInsensitiveSync").mockReturnValue(false);
  const target = path.join(directory, "case");
  assertMutationNotDenied(target, { paths: [path.join(directory, "Case"), path.join(directory, "CASE")] });
  expect(probe).toHaveBeenCalledTimes(1);
  probe.mockClear();
  expect(() => assertMutationNotDenied(target, { paths: [target] })).toThrow();
  assertMutationNotDenied(target, { prefixes: [path.join(directory, "unrelated")] });
  expect(probe).not.toHaveBeenCalled();
  // A new admission cannot inherit sensitivity from the previous one.
  probe.mockReturnValue(undefined);
  expect(() => assertMutationNotDenied(target, { paths: [path.join(directory, "Case")] })).toThrow();
  expect(probe).toHaveBeenCalledTimes(1);
});

it("fails closed if canonical observations are unavailable", async () => {
  const directory = await tempRoot("fs-safe-deny-unobserved-");
  vi.spyOn(realpathSync, "native").mockImplementation(() => { throw new Error("unavailable"); });
  expect(() => assertMutationNotDenied(path.join(directory, "case"), { paths: [path.join(directory, "Case")] }))
    .toThrow(expect.objectContaining({ code: "denied-path" }));
});

it.each([["\u1fb3\u0315", "\u03b1\u0315\u03b9"], ["Stra\u00dfe", "STRASSE"], ["\u00df", "\u1e9e"], ["\u03c2", "\u03c3"], ["\u00c9", "e\u0301"]])(
  "fails closed for Unicode folds %s / %s", async (denied, target) => {
    const directory = await tempRoot("fs-safe-deny-unicode-fold-");
    vi.spyOn(caseProbe, "probePathCaseInsensitiveSync").mockReturnValue(false);
    expect(() => assertMutationNotDenied(path.join(directory, target), { paths: [path.join(directory, denied)] }))
      .toThrow(expect.objectContaining({ code: "denied-path" }));
  },
);

it.skipIf(process.platform === "win32")("keeps distinct existing case-sensitive ancestors separate", async ({ skip }) => {
  const directory = await tempRoot("fs-safe-deny-existing-distinct-");
  fs.mkdirSync(path.join(directory, "Parent"));
  if (fs.existsSync(path.join(directory, "parent"))) skip();
  fs.mkdirSync(path.join(directory, "parent"));
  expect(() => assertMutationNotDenied(path.join(directory, "parent", "cafe\u0301"), {
    paths: [path.join(directory, "Parent", "caf\u00e9")],
  })).not.toThrow();
});

it.skipIf(process.platform === "win32")("canonicalizes a symlink ancestor before prospective comparison", async () => {
  const directory = await tempRoot("fs-safe-deny-link-");
  fs.mkdirSync(path.join(directory, "actual"));
  fs.symlinkSync(path.join(directory, "actual"), path.join(directory, "alias"), "dir");
  expect(() => assertMutationNotDenied(path.join(directory, "alias", "cafe\u0301"), {
    paths: [path.join(directory, "actual", "caf\u00e9")],
  })).toThrow(expect.objectContaining({ code: "denied-path" }));
});

it("protects prospective aliased ancestors for move destinations", async () => {
  const directory = await tempRoot("fs-safe-deny-move-ancestor-");
  fs.mkdirSync(path.join(directory, "source"));
  const safe = await root(directory);
  await expect(safe.move("source", "cafe\u0301", {
    denyMutations: { paths: [path.join(directory, "caf\u00e9", "protected")] },
  })).rejects.toMatchObject({ code: "denied-path" });
  expect(fs.readdirSync(directory)).toEqual(["source"]);
});

it("keeps dotless i distinct under canonical Unicode case folding", async () => {
  const directory = await tempRoot("fs-safe-deny-dotless-");
  for (const [denied, target] of [["file", "f\u0131le"], ["I", "\u0131"], ["i", "\u0130"]]) {
    expect(() => assertMutationNotDenied(path.join(directory, target!), {
      paths: [path.join(directory, denied!)],
    })).not.toThrow();
    expect(() => assertMutationNotDenied(path.join(directory, target!, "child"), {
      prefixes: [path.join(directory, denied!)],
    })).not.toThrow();
    expect(() => assertMutationNotDenied(path.join(directory, target!), {
      paths: [path.join(directory, denied!, "child")],
    }, { protectAncestors: true })).not.toThrow();
  }
});
