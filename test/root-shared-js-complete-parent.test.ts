import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureFsSafeNative,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { realpathSync } from "../src/realpath.js";
import * as writeAdmission from "../src/root-write-admission.js";
import { root, type RootOpenWritableOptions } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { observeMutationAuthorizations } from "./helpers/root-shared-js-admission.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const describeNode = describe.skipIf(Boolean(process.versions.bun));

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function targetFixture(name: string, parentPath: string, existing: boolean) {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot(`fs-safe-shared-policy-fast-${name}-`);
  const parent = path.join(directory, parentPath);
  const target = path.join(parent, "value");
  if (parentPath) await fs.mkdir(parent);
  if (existing) await fs.writeFile(target, "original");
  return { directory, parent, target };
}

async function rejectUpdate(
  directory: string,
  target: string,
  options: RootOpenWritableOptions = {
    denyMutations: { prefixes: [path.join(directory, "denied")] },
    mutationSymlinks: "reject",
  },
  code = "path-mismatch",
) {
  const open = vi.spyOn(fs, "open");
  const safe = await root(directory);
  await expect(safe.openWritable(path.relative(directory, target), {
    writeMode: "update", ...options,
  })).rejects.toMatchObject({ code });
  expect(open).not.toHaveBeenCalled();
}

async function authorizationCounts(depths: readonly number[], withCallback: boolean) {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-shared-policy-depth-");
  const safe = await root(directory);
  const counts = observeMutationAuthorizations();
  const observed: number[] = [];
  let previous = 0;
  for (const depth of depths) {
    const parent = path.join(directory, `depth-${depth}`,
      ...Array.from({ length: depth - 1 }, (_, index) => `d${index}`));
    const target = path.join(parent, "value");
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(target, "original");
    const callback = withCallback ? vi.fn() : undefined;
    const opened = await safe.openWritable(path.relative(directory, target), {
      writeMode: withCallback ? "replace" : "update",
      denyMutations: { prefixes: [path.join(directory, "denied")] },
      mutationSymlinks: "reject",
      assertBeforeMutation: callback,
    });
    await opened.handle.close();
    if (callback) expect(callback).toHaveBeenCalledTimes(1);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    observed.push(total - previous);
    previous = total;
  }
  return observed;
}

describeNode("shared JavaScript complete-parent admission", () => {
  it("keeps complete-parent authorization count constant with route depth", async () => {
    expect(await authorizationCounts([1, 8, 32], false)).toEqual([2, 2, 2]);
  });

  it("keeps authority callbacks on the component-walk route", async () => {
    const observed = await authorizationCounts([1, 8], true);
    expect(observed[1]).toBeGreaterThan(observed[0]!);
  });

  it("invalidates a complete-parent guard after exact parent replacement", async () => {
    const { directory, parent, target } = await targetFixture("parent-swap", "parent", true);
    const saved = path.join(directory, "saved");
    let replaced = false;
    observeMutationAuthorizations({
      afterAuthorize(request) {
        if (replaced || request.phase !== "parent") return;
        replaced = true;
        fsSync.renameSync(parent, saved);
        fsSync.mkdirSync(parent);
      },
    });
    await rejectUpdate(directory, target);

    expect(replaced).toBe(true);
    expect(await fs.readdir(parent)).toEqual([]);
    expect(await fs.readFile(path.join(saved, "value"), "utf8")).toBe("original");
  });

  it.skipIf(process.platform === "win32")(
    "invalidates a complete-parent guard after canonical parent replacement",
    async () => {
      const { directory, parent, target } = await targetFixture("parent-alias", "parent", true);
      const saved = path.join(directory, "saved");
      let replaced = false;
      observeMutationAuthorizations({
        afterAuthorize(request) {
          if (replaced || request.phase !== "parent") return;
          replaced = true;
          fsSync.renameSync(parent, saved);
          fsSync.symlinkSync(saved, parent, "dir");
        },
      });
      await rejectUpdate(directory, target);

      expect(replaced).toBe(true);
      expect(await fs.readFile(path.join(saved, "value"), "utf8")).toBe("original");
    },
  );

  it.skipIf(process.platform === "win32")(
    "invalidates a complete-parent guard after exact root replacement",
    async () => {
      const { directory, target } = await targetFixture("root-swap", "parent", true);
      const saved = `${directory}-saved`;
      let replaced = false;
      observeMutationAuthorizations({
        afterAuthorize(request) {
          if (replaced || request.phase !== "parent") return;
          replaced = true;
          fsSync.renameSync(directory, saved);
          fsSync.mkdirSync(directory);
          fsSync.mkdirSync(path.join(directory, "parent"));
        },
      });
      try {
        await rejectUpdate(directory, target);
        expect(replaced).toBe(true);
        expect(await fs.readFile(path.join(saved, "parent/value"), "utf8")).toBe("original");
      } finally {
        if (replaced) {
          await fs.rm(directory, { recursive: true, force: true });
          await fs.rename(saved, directory);
        }
      }
    },
  );

  it("invalidates an unexpectedly appearing child after complete-parent admission", async () => {
    const { directory, target } = await targetFixture("child-appearance", "parent", false);
    let appeared = false;
    observeMutationAuthorizations({
      afterAuthorize(request) {
        if (appeared || request.phase !== "parent") return;
        appeared = true;
        fsSync.writeFileSync(target, "injected");
      },
    });
    await rejectUpdate(directory, target);

    expect(appeared).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("injected");
  });

  it("invalidates complete-parent evidence when native mode changes during admission", async () => {
    const { directory, target } = await targetFixture("mode-change", "", true);
    let changed = false;
    observeMutationAuthorizations({
      afterAuthorize(request) {
        if (changed || request.phase !== "parent") return;
        changed = true;
        configureFsSafeNative({ mode: "auto" });
      },
    });
    await rejectUpdate(directory, target);

    expect(changed).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  it("preserves original-route denial before complete-parent dispatch", async () => {
    const { directory, target } = await targetFixture("denial-order", "", true);
    const unrelated = path.join(directory, "unrelated");
    const deniedAlias = path.join(directory, "denied-alias");
    await fs.writeFile(unrelated, "unrelated");
    await fs.symlink(unrelated, deniedAlias, "file");
    let retargeted = false;
    observeMutationAuthorizations({
      async beforeAuthorize(request) {
        if (retargeted || request.phase !== "parent") return;
        retargeted = true;
        await fs.unlink(deniedAlias);
        await fs.symlink(target, deniedAlias, "file");
      },
    });
    await rejectUpdate(directory, target, { denyMutations: { paths: [deniedAlias] } }, "denied-path");

    expect(retargeted).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });
});

type ScenarioContext = Readonly<{
  directory: string;
  parent: string;
  target: string;
  armed(): boolean;
}>;

type PreparationFailureScenario = Readonly<{
  name: string;
  expectedReceipt?: Readonly<{
    name: string;
    code: string;
    causeCode: string | undefined;
  }>;
  mutationSymlinks?: "reject";
  setup(context: ScenarioContext): Promise<void>;
  install?(context: ScenarioContext): void;
  afterPreflight?(context: ScenarioContext): void;
}>;

type ErrorReceipt = Readonly<{
  name: string;
  code?: string;
  message: string;
  causeName?: string;
  causeCode?: string;
  causeMessage?: string;
}>;

function errno(code: string, syscall: string, pathname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected ${syscall}, '${pathname}'`), {
    code,
    path: pathname,
    syscall,
  });
}

function errorReceipt(error: unknown, directory: string): ErrorReceipt {
  const observed = error as Error & { code?: string; cause?: unknown };
  const cause = observed.cause as (Error & { code?: string }) | undefined;
  const normalize = (value: string | undefined) => value?.replaceAll(directory, "<root>");
  return {
    name: observed.name,
    code: observed.code,
    message: normalize(observed.message) ?? "",
    causeName: cause?.name,
    causeCode: cause?.code,
    causeMessage: normalize(cause?.message),
  };
}

function installLstatFailure(context: ScenarioContext, pathname: string, code: string): void {
  const realLstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<
    typeof fsSync.lstatSync
  >) => {
    if (context.armed() && path.resolve(String(args[0])) === path.resolve(pathname)) {
      throw errno(code, "lstat", pathname);
    }
    return realLstat(...args);
  }) as typeof fsSync.lstatSync);
}

const scenarios: readonly PreparationFailureScenario[] = [
  {
    name: "an intermediate component becomes a non-directory",
    expectedReceipt: { name: "FsSafeError", code: "path-alias", causeCode: "ENOTDIR" },
    async setup({ parent }) {
      await fs.mkdir(parent, { recursive: true });
    },
    afterPreflight({ directory }) {
      const first = path.join(directory, "one");
      fsSync.rmSync(first, { force: true, recursive: true });
      fsSync.writeFileSync(first, "not a directory");
    },
  },
  {
    name: "complete-parent observation loses permission",
    expectedReceipt: { name: "FsSafeError", code: "path-alias", causeCode: "EACCES" },
    async setup({ parent }) {
      await fs.mkdir(parent, { recursive: true });
    },
    install(context) {
      installLstatFailure(context, context.parent, "EACCES");
    },
  },
  {
    name: "target observation loses permission",
    expectedReceipt: { name: "FsSafeError", code: "path-alias", causeCode: "EPERM" },
    async setup({ parent, target }) {
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(target, "original");
    },
    install(context) {
      installLstatFailure(context, context.target, "EPERM");
    },
  },
  {
    name: "target canonicalization loses permission",
    expectedReceipt: { name: "Error", code: "EACCES", causeCode: undefined },
    async setup({ parent, target }) {
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(target, "original");
    },
    install(context) {
      const realNative = realpathSync.native.bind(realpathSync);
      vi.spyOn(realpathSync, "native").mockImplementation((pathname) => {
        if (context.armed() && path.resolve(pathname) === path.resolve(context.target)) {
          throw errno("EACCES", "realpath", pathname);
        }
        return realNative(pathname);
      });
    },
  },
];

async function runScenario(
  scenario: PreparationFailureScenario,
  forceComponentWalk: boolean,
) {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-shared-policy-preparation-error-");
  const parent = path.join(directory, "one", "two");
  const target = path.join(parent, "value");
  let armed = false;
  const context: ScenarioContext = { directory, parent, target, armed: () => armed };
  await scenario.setup(context);
  const safe = await root(directory);
  scenario.install?.(context);
  const resolveTarget = writeAdmission.resolveGuardedWriteTargetInRoot;
  let changed = false;
  vi.spyOn(writeAdmission, "resolveGuardedWriteTargetInRoot").mockImplementation(
    async (...args) => {
      const guarded = await resolveTarget(...args);
      if (!changed) {
        scenario.afterPreflight?.(context);
        armed = true;
        changed = true;
      }
      return guarded;
    },
  );
  const open = vi.spyOn(fs, "open");
  const mkdir = vi.spyOn(fs, "mkdir");
  let failure: unknown;
  try {
    const opened = await safe.openWritable(path.relative(directory, target), {
      writeMode: "update",
      denyMutations: { paths: [path.join(directory, "unrelated")] },
      mutationSymlinks: scenario.mutationSymlinks,
      assertBeforeMutation: forceComponentWalk ? vi.fn() : undefined,
    });
    await opened.handle.close();
  } catch (error) {
    failure = error;
  }

  expect(changed).toBe(true);
  expect(failure).toBeDefined();
  return { receipt: errorReceipt(failure, directory), open, mkdir };
}

describeNode("shared JavaScript complete-parent preparation failures", () => {
  it.each(scenarios)("preserves ordered error classification when $name", async (scenario) => {
    const established = await runScenario(scenario, true);
    expect(established.open).not.toHaveBeenCalled();
    expect(established.mkdir).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const optimized = await runScenario(scenario, false);
    expect(optimized.open).not.toHaveBeenCalled();
    expect(optimized.mkdir).not.toHaveBeenCalled();

    expect(optimized.receipt).toEqual(established.receipt);
    expect(optimized.receipt).toMatchObject(scenario.expectedReceipt);
  });

  it.runIf(process.platform === "win32").each(["EACCES", "EPERM", "ENOTDIR"] as const)(
    "keeps incomplete missing-suffix %s evidence on the ordered failure path",
    async (code) => {
      const scenario: PreparationFailureScenario = {
        name: `missing-suffix ${code}`,
        mutationSymlinks: "reject",
        async setup() {}, // Leave both parent components absent.
        install(context) { installLstatFailure(context, context.target, code); },
      };
      const established = await runScenario(scenario, true);
      vi.restoreAllMocks();
      const optimized = await runScenario(scenario, false);
      expect(optimized.receipt).toEqual(established.receipt);
    },
  );
});
