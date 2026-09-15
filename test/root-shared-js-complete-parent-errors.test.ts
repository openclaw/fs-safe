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
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const describeNode = describe.skipIf(Boolean(process.versions.bun));

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

type ScenarioContext = Readonly<{
  directory: string;
  parent: string;
  target: string;
  armed(): boolean;
}>;

type PreparationFailureScenario = Readonly<{
  name: string;
  causeCode: "EACCES" | "ENOTDIR" | "EPERM";
  expectedReceipt: Readonly<{
    name: string;
    code: string;
    causeCode: string | undefined;
  }>;
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
    causeCode: "ENOTDIR",
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
    causeCode: "EACCES",
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
    causeCode: "EPERM",
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
    causeCode: "EACCES",
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
): Promise<ErrorReceipt> {
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
      assertBeforeMutation: forceComponentWalk ? vi.fn() : undefined,
    });
    await opened.handle.close();
  } catch (error) {
    failure = error;
  }

  expect(changed).toBe(true);
  expect(failure).toBeDefined();
  expect(open).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
  return errorReceipt(failure, directory);
}

describeNode("shared JavaScript complete-parent preparation failures", () => {
  it.each(scenarios)("preserves ordered error classification when $name", async (scenario) => {
    const established = await runScenario(scenario, true);
    vi.restoreAllMocks();
    const optimized = await runScenario(scenario, false);

    expect(optimized).toEqual(established);
    expect(optimized).toMatchObject(scenario.expectedReceipt);
  });
});
