import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeExtractedTreeIntoDestination } from "../src/archive.js";
import type { ExtractionDeadline } from "../src/archive-deadline.js";
import { pinNodeDirectoryForMode } from "../src/directory-mode-node.js";
import {
  ownDirectoryMode,
  type DirectoryModeChecks,
} from "../src/directory-mode-owner.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

const thrownValues: { name: string; value: unknown }[] = [
  { name: "undefined", value: undefined },
  { name: "null", value: null },
  { name: "false", value: false },
  { name: "positive zero", value: 0 },
  { name: "negative zero", value: -0 },
  { name: "zero bigint", value: 0n },
  { name: "empty string", value: "" },
  { name: "NaN", value: Number.NaN },
  { name: "true", value: true },
  { name: "nonzero number", value: 1 },
  { name: "nonzero bigint", value: 1n },
  { name: "nonempty string", value: "stop" },
  { name: "symbol", value: Symbol("stop") },
  { name: "plain object", value: Object.freeze({ reason: "stop" }) },
  { name: "function", value: () => undefined },
  { name: "Error", value: new Error("stop") },
];

async function settle(promise: Promise<void>): Promise<
  { status: "fulfilled" } | { status: "rejected"; reason: unknown }
> {
  return await promise.then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

describe("directory mode pre-chmod checks", () => {
  it.each(thrownValues.flatMap(({ name, value }) => [false, true].map((ignoreChmodError) => ({
    name,
    value,
    ignoreChmodError,
  }))))(
    "preserves one-shot $name with ignoreChmodError=$ignoreChmodError",
    async ({ value, ignoreChmodError }) => {
      let mode = 0o700;
      let checks = 0;
      const events: string[] = [];
      const close = vi.fn(async () => { events.push("close"); });
      const owner = ownDirectoryMode({
        inspect: async () => { events.push("inspect"); return mode; },
        chmod: async (nextMode) => { events.push("chmod"); mode = nextMode; },
        verifyChmod: async () => { events.push("verify chmod"); },
        close,
        ignoreChmodError,
      });

      const operation = owner.apply(0o755, {
        check: () => {
          checks += 1;
          events.push(`check ${checks}`);
          if (checks === 6) throw value;
        },
      });
      const closing = owner.close();
      const outcome = await settle(operation);
      await closing;
      await owner.close();

      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(Object.is(outcome.reason, value)).toBe(true);
      expect(mode).toBe(0o700);
      expect(events).toEqual([
        "check 1", "inspect", "check 2", "check 3", "check 4", "inspect",
        "check 5", "check 6", "close",
      ]);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("propagates a throwing check accessor before best-effort chmod", async () => {
    const failure = { reason: "accessor failed" };
    let accesses = 0;
    const chmod = vi.fn(async () => undefined);
    const verifyChmod = vi.fn(async () => undefined);
    const inspect = vi.fn(async () => 0o700);
    const owner = ownDirectoryMode({
      inspect,
      chmod,
      verifyChmod,
      close: async () => undefined,
      ignoreChmodError: true,
    });
    const checks: DirectoryModeChecks = {
      get check() {
        accesses += 1;
        if (accesses === 6) throw failure;
        return () => undefined;
      },
    };
    try {
      const outcome = await settle(owner.apply(0o755, checks));
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toBe(failure);
      expect(accesses).toBe(6);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(chmod).not.toHaveBeenCalled();
      expect(verifyChmod).not.toHaveBeenCalled();
    } finally {
      await owner.close();
    }
  });

  it.each(["synchronous throw", "promise rejection"] as const)(
    "keeps actual chmod $failureKind ignore and propagation behavior",
    async (failureKind) => {
      for (const ignoreChmodError of [false, true]) {
        const failure = new Error(`${failureKind} ${ignoreChmodError}`);
        let checks = 0;
        const inspect = vi.fn(async () => 0o700);
        const verifyChmod = vi.fn(async () => undefined);
        const failChmod: (mode: number) => Promise<void> = failureKind === "synchronous throw"
          ? () => { throw failure; }
          : async () => { throw failure; };
        const chmod = vi.fn(failChmod);
        const owner = ownDirectoryMode({
          inspect,
          chmod,
          verifyChmod,
          close: async () => undefined,
          ignoreChmodError,
        });
        try {
          const outcome = await settle(owner.apply(0o755, { check: () => { checks += 1; } }));
          if (ignoreChmodError) {
            expect(outcome.status).toBe("fulfilled");
            expect(checks).toBe(8);
            expect(inspect).toHaveBeenCalledTimes(3);
            expect(verifyChmod).toHaveBeenCalledOnce();
          } else {
            expect(outcome.status).toBe("rejected");
            if (outcome.status === "rejected") expect(outcome.reason).toBe(failure);
            expect(checks).toBe(6);
            expect(inspect).toHaveBeenCalledTimes(2);
            expect(verifyChmod).not.toHaveBeenCalled();
          }
          expect(chmod).toHaveBeenCalledOnce();
        } finally {
          await owner.close();
        }
      }
    },
  );

  itWin32("preserves a one-shot failure through the Windows identity-only owner", async () => {
    const directory = await tempRoot("fs-safe-directory-mode-check-win32-");
    const failure = Object.freeze({ reason: "Windows authority ended" });
    const owner = await pinNodeDirectoryForMode(directory);
    let checks = 0;
    const operation = owner.apply(0o755, {
      check: () => {
        checks += 1;
        if (checks === 6) throw failure;
      },
    });
    const closing = owner.close();
    const outcome = await settle(operation);
    await closing;
    await owner.close();
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe(failure);
    expect(checks).toBe(6);
  });

  itWin32.each([
    { name: "undefined", value: undefined },
    { name: "object", value: Object.freeze({ reason: "custom structural lease ended" }) },
  ])("propagates one-shot $name through the public archive merge", async ({ value }) => {
    const base = await tempRoot("fs-safe-directory-mode-check-merge-");
    const sourceDir = path.join(base, "source");
    const sourceNested = path.join(sourceDir, "nested");
    const destinationDir = path.join(base, "destination");
    const destinationNested = path.join(destinationDir, "nested");
    await fs.mkdir(sourceDir);
    await fs.mkdir(sourceNested, { mode: 0o555 });
    if (process.platform !== "win32") await fs.chmod(sourceNested, 0o555);
    await fs.mkdir(destinationDir);

    let armed = false;
    let failed = false;
    let checks = 0;
    let armedChecks = 0;
    __setFsSafeTestHooksForTest({
      beforeArchiveOutputMutation(operation, targetPath) {
        if (operation === "chmod" && targetPath === destinationNested) armed = true;
      },
    });
    const signal = new AbortController().signal;
    const deadline: ExtractionDeadline = {
      signal,
      check: () => {
        checks += 1;
        if (armed) armedChecks += 1;
        // The first 16 armed checks cover the merge guards, owner.verify(), and
        // apply's hook/identity rechecks. Check 17 is immediately before chmod.
        if (armedChecks === 17 && !failed) {
          failed = true;
          throw value;
        }
      },
      ownDestinationMutation: async (run) => await run(),
      waitForDestinationMutations: async () => undefined,
      dispose: () => undefined,
    };

    const outcome = await settle(mergeExtractedTreeIntoDestination({
      sourceDir,
      destinationDir,
      destinationRealDir: destinationDir,
      deadline,
    }));
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(Object.is(outcome.reason, value)).toBe(true);
    expect({ armed, failed }).toEqual({ armed: true, failed: true });
    expect(checks).toBeGreaterThan(0);
    expect(armedChecks).toBe(17);
    expect((await fs.lstat(destinationNested)).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.lstat(destinationNested)).mode & 0o7777).toBe(0o700);
    }
  });
});
