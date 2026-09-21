import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root, type Root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
});

class CustomFailure extends Error { readonly code = "EACCES"; }
const cases = [
  { name: "Error", value: Object.assign(new Error("not public diagnostic text"), { code: "EIO" }), writeCode: "invalid-path" },
  { name: "Error subclass", value: new CustomFailure("not public diagnostic text"), writeCode: "invalid-path" },
  { name: "cross-realm Error", value: vm.runInNewContext('Object.assign(new Error("foreign"), { code: "EIO" })') as unknown, writeCode: "invalid-path" },
  { name: "errno record", value: { code: "EIO" }, writeCode: "invalid-path" },
  { name: "undefined", value: undefined, writeCode: "invalid-path" },
  { name: "null", value: null, writeCode: "invalid-path" },
  { name: "false", value: false, writeCode: "invalid-path" },
  { name: "zero", value: 0, writeCode: "invalid-path" },
  { name: "bigint", value: 0n, writeCode: "invalid-path" },
  { name: "symbol", value: Symbol("failure"), writeCode: "invalid-path" },
  { name: "collision string", value: "EEXIST", writeCode: "already-exists" },
] as const;

const routes = [
  {
    name: "stream create without details",
    ownDetailsOption: false,
    run: (scoped: Root) => scoped.create("nested/value", (async function* () { yield Buffer.from("value"); })()),
  },
  { name: "mkdir with explicit undefined details", ownDetailsOption: true, run: (scoped: Root) => scoped.mkdir("created") },
];

async function fixture(value: unknown) {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-error-cause-");
  await fs.mkdir(path.join(directory, "nested"));
  const scoped = await root(directory);
  __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: () => { throw value; } });
  return { directory, scoped };
}

async function captureWithInheritedDetails(run: () => Promise<unknown>, cause: unknown) {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "details");
  const inherited = Object.freeze({ marker: "inherited error details" });
  let optionReads = 0;
  Object.defineProperty(Object.prototype, "details", {
    configurable: true,
    get(this: object) {
      if (Object.getPrototypeOf(this) === Object.prototype &&
          Object.getOwnPropertyDescriptor(this, "cause")?.value === cause && Object.hasOwn(this, "cause")) {
        optionReads++;
      }
      return inherited;
    },
  });
  try {
    try { await run(); } catch (error) { return { error, inherited, optionReads }; }
    throw new Error("Expected public operation to fail");
  } finally {
    if (original) Object.defineProperty(Object.prototype, "details", original);
    else Reflect.deleteProperty(Object.prototype, "details");
  }
}

describe.each(routes)("public error cause ownership: $name", ({ run, ownDetailsOption }) => {
  it.each(cases)("retains the cause/details shape for $name", async ({ value, writeCode }) => {
    const { directory, scoped } = await fixture(value);
    const cause = value instanceof Error ? value : undefined;
    const { error, inherited, optionReads } = await captureWithInheritedDetails(() => run(scoped), cause);
    expect(error).toBeInstanceOf(FsSafeError);
    expect(error).toMatchObject({ code: ownDetailsOption ? "path-alias" : writeCode, category: "policy" });
    const failure = error as FsSafeError;
    expect(Object.getOwnPropertyDescriptor(failure, "cause")).toEqual({
      value: cause, writable: true, enumerable: false, configurable: true,
    });
    expect(Object.hasOwn(failure, "details")).toBe(true);
    expect(failure.details).toBe(ownDetailsOption ? undefined : inherited);
    expect(optionReads).toBe(ownDetailsOption ? 0 : 1);
    expect((await fs.readdir(directory)).sort()).toEqual(["nested"]);
    expect(await fs.readdir(path.join(directory, "nested"))).toEqual([]);
  });

  it("preserves an already classified error, primitive cause and exact details", async () => {
    const details = Object.freeze({ phase: "owned", cleanup: "preserved" });
    const primary = new FsSafeError("symlink", "classified failure", { cause: false, details });
    const { scoped } = await fixture(primary);
    const { error } = await captureWithInheritedDetails(() => run(scoped), primary);
    expect(error).toBe(primary);
    expect(primary.cause).toBe(false);
    expect(primary.details).toBe(details);
  });
});
