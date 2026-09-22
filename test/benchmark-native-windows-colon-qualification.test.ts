import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_WINDOWS_COLON_FILTER as filter,
  NATIVE_WINDOWS_COLON_NAMES as names,
  qualifyNativeWindowsColon as qualify,
  validateNativeWindowsColonQualification as validateQualification,
  validateNativeWindowsColonReport as validateReport,
} from "../benchmarks/native-windows-colon.mjs";
import {
  nativeColonFacts as facts, nativeColonLoader as loader,
  nativeColonQualification as receipt, nativeColonReport as report,
} from "./helpers/native-windows-colon-qualification.js";

afterEach(() => vi.restoreAllMocks());
const args = { filter, mode: "require" };
const reasons = {
  stream: "Windows filesystem path contains alternate stream syntax",
  nul: "Windows path contains a NUL byte",
};

function syntheticCases() {
  const events: string[] = [];
  const cases = names.map((name: string, index: number) => {
    let passes = 0;
    let lastInput: { name: string; pass: number };
    const expectedMessage = name.endsWith("/nul") ? reasons.nul : reasons.stream;
    return {
      name, sync: true, expectError: index === 0 ? undefined : true,
      before: vi.fn(async () => {
        events.push(`before:${name}`);
        await Promise.resolve();
        lastInput = { name, pass: ++passes };
        events.push(`ready:${name}`);
        return lastInput;
      }),
      run: vi.fn((input: unknown) => {
        assert.equal(input, lastInput, "before result was not awaited/forwarded");
        events.push(`run:${name}`);
        if (index > 0) throw Object.assign(new Error(expectedMessage), { code: "EINVAL" });
        return facts();
      }),
      after: vi.fn(async (output: unknown, input: unknown) => {
        assert.equal(input, lastInput, "after received the wrong fixture");
        events.push(`after:${name}`);
        if (index === 0) assert.deepEqual(output, facts());
        else {
          assert(output instanceof Error);
          assert.equal((output as NodeJS.ErrnoException).code, "EINVAL");
          assert.equal(output.message, expectedMessage);
        }
        await Promise.resolve();
        events.push(`settled:${name}`);
      }),
    };
  });
  return { events, cases, options: { cases, args, nativeLoader: loader(), platform: "win32" } };
}

describe("native Windows colon upfront qualification", () => {
  it("awaits two complete nine-row passes in order without reading clocks", async () => {
    const f = syntheticCases();
    const clocks = [vi.spyOn(performance, "now"), vi.spyOn(Date, "now"), vi.spyOn(process.hrtime, "bigint")];
    const clockReads: number[] = [];
    for (const clock of clocks) clock.mockImplementation(() => { throw new Error("qualification read a clock"); });
    let actual;
    try { actual = await qualify(f.options); }
    finally {
      clockReads.push(...clocks.map(clock => clock.mock.calls.length));
      clocks.forEach(clock => clock.mockRestore());
    }
    expect(clockReads).toEqual([0, 0, 0]);
    expect(actual).toEqual(receipt(f.options.nativeLoader));
    expect(actual.nativeLoader).not.toBe(f.options.nativeLoader);
    expect(f.events).toEqual([1, 2].flatMap(() => names.flatMap((name: string) =>
      ["before", "ready", "run", "after", "settled"].map(stage => `${stage}:${name}`))));
    for (const row of f.cases) {
      expect(row.before).toHaveBeenCalledTimes(2);
      expect(row.run).toHaveBeenCalledTimes(2);
      expect(row.after).toHaveBeenCalledTimes(2);
      expect(row.run.mock.calls.map(([input]) => input)).toEqual([{ name: row.name, pass: 1 }, { name: row.name, pass: 2 }]);
    }
  });

  it("allows unrelated registered cases but never invokes them", async () => {
    const f = syntheticCases();
    const unrelated = { name: "other", run: vi.fn(() => { throw new Error("unrelated row ran"); }) };
    const actual = await qualify({ ...f.options, cases: [unrelated, ...f.cases, unrelated] });
    expect(actual.calls).toBe(18);
    expect(unrelated.run).not.toHaveBeenCalled();
  });

  it.each(["", "readOwnerAndDacl", "native-windows-colon", `${filter}private-admission`])(
    "returns null without qualification for non-opt-in filter %s", async selected => {
      await expect(qualify({ cases: null, args: { filter: selected, mode: "off" }, nativeLoader: null, platform: "linux" }))
        .resolves.toBeNull();
    },
  );

  it.each(["platform", "mode", "loader"])("rejects invalid %s before callbacks", async field => {
    const f = syntheticCases();
    const change = field === "platform" ? { platform: "linux" }
      : field === "mode" ? { args: { filter, mode: "off" } } : { nativeLoader: null };
    await expect(qualify({ ...f.options, ...change })).rejects.toThrow();
    expect(f.events).toEqual([]);
  });

  it.each(["missing", "duplicate", "reordered", "disguised", "nested-options"])(
    "rejects %s qualification rows before callbacks", async mutation => {
      const f = syntheticCases();
      if (mutation === "missing") f.cases.pop();
      if (mutation === "duplicate") f.cases.push(f.cases[0]!);
      if (mutation === "reordered") f.cases.reverse();
      if (mutation === "disguised") f.cases.push({ ...f.cases[1]!, name: `other/${f.cases[1]!.name}` });
      const cases = mutation === "nested-options" ? f.cases.map(({ name, run, ...options }) => ({ name, run, options })) : f.cases;
      await expect(qualify({ ...f.options, cases })).rejects.toThrow();
      expect(f.events).toEqual([]);
    },
  );

  it("requires synchronous, unskipped, unbatched callbacks with the right rejection contract", async () => {
    for (const [index, change] of [
      [0, { sync: false }], [1, { skip: "unsupported" }], [0, { expectError: true }],
      [1, { expectError: undefined }], [0, { divisor: 2 }], [1, { batch: 2 }],
      [0, { before: undefined }], [1, { run: undefined }], [8, { after: undefined }],
    ] as const) {
      const f = syntheticCases();
      Object.assign(f.cases[index]!, change);
      await expect(qualify(f.options)).rejects.toThrow();
      expect(f.events).toEqual([]);
    }
  });

  it.each([undefined, null, false, 0, ""])("preserves falsey before/run/after failures (%s) and stops", async failure => {
    for (const stage of ["before", "run", "after"] as const) {
      const f = syntheticCases();
      Object.assign(f.cases[0]!, { [stage]: vi.fn(() => { throw failure; }) });
      if (stage === "run") Object.assign(f.cases[0]!, { after: vi.fn() });
      const outcome = await qualify(f.options).then(() => ({ resolved: true }), error => ({ resolved: false, error }));
      expect(outcome).toEqual({ resolved: false, error: failure });
      for (const row of f.cases.slice(1)) expect(row.before).not.toHaveBeenCalled();
      expect(f.cases[0]!.after).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
      expect(f.cases[0]!.run).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    }
  });

  it("retains the primary and settlement failures in order", async () => {
    const f = syntheticCases();
    const cleanup = new Error("synthetic after failure");
    Object.assign(f.cases[0]!, {
      run: vi.fn(() => { throw undefined; }),
      after: vi.fn(async () => { await Promise.resolve(); throw cleanup; }),
    });
    const failure = await qualify(f.options).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([undefined, cleanup]);
    expect(f.cases[1]!.before).not.toHaveBeenCalled();
  });

  it("fails an unexpectedly successful private call before admitting later rows", async () => {
    const f = syntheticCases();
    Object.assign(f.cases[1]!, { run: vi.fn(() => "unexpected"), after: vi.fn() });
    await expect(qualify(f.options)).rejects.toThrow("unexpectedly succeeded during upfront qualification");
    expect(f.cases[1]!.after).toHaveBeenCalledExactlyOnceWith("unexpected", { name: names[1], pass: 1 });
    expect(f.cases[2]!.before).not.toHaveBeenCalled();
  });

  it("fails a checked wrong native error before admitting later rows", async () => {
    const f = syntheticCases();
    Object.assign(f.cases[1]!, { run: vi.fn(() => { throw Object.assign(new Error("wrong route"), { code: "ENOTSUP" }); }) });
    await expect(qualify(f.options)).rejects.toThrow();
    expect(f.cases[1]!.after).toHaveBeenCalledOnce();
    expect(f.cases[2]!.before).not.toHaveBeenCalled();
  });

  it("runs upfront qualification before the stock runner's result/timing loop", () => {
    const source = fs.readFileSync(new URL("../benchmarks/runner.mjs", import.meta.url), "utf8");
    const qualification = source.indexOf("await qualifyNativeWindowsColon({ cases, args, nativeLoader })");
    expect(qualification).toBeGreaterThan(source.indexOf("Unmeasured methods:"));
    expect(qualification).toBeLessThan(source.indexOf("const results = []"));
    expect(qualification).toBeLessThan(source.indexOf("performance.now()"));
    expect(source).toContain("nativeWindowsColonQualification,");
  });
});

describe("native Windows colon qualification receipt admission", () => {
  it("accepts the complete ordered receipt bound to the loaded artifact", () => {
    expect(() => validateQualification(receipt(), loader())).not.toThrow();
    expect(() => validateReport(report(), filter, 20, 5)).not.toThrow();
  });

  it.each([undefined, null, false, "", {}])("rejects absent or invalid qualification %s in a report", value => {
    const input = report();
    Object.assign(input.metadata, { nativeWindowsColonQualification: value });
    expect(() => validateReport(input, filter, 20, 5)).toThrow();
  });

  it("requires all exact receipt fields and loader identity", () => {
    for (const field of Object.keys(receipt())) {
      const value = receipt();
      Reflect.deleteProperty(value, field);
      expect(() => validateQualification(value, loader())).toThrow();
    }
    for (const change of [{ schemaVersion: 0 }, { phase: "after timing" }, { timer: "measured" },
      { passes: 1 }, { calls: 17 }, { calls: 19 }, { extra: true }, { nativeLoader: loader("b".repeat(64)) }]) {
      expect(() => validateQualification({ ...receipt(), ...change }, loader())).toThrow();
    }
  });

  it.each(["missing", "duplicate", "reordered", "pass", "name", "extra-field", "public", "private-code", "private-reason", "private-type"])(
    "rejects %s outcome evidence", mutation => {
      const value = receipt();
      if (mutation === "missing") value.outcomes.pop();
      if (mutation === "duplicate") value.outcomes.push(value.outcomes[0]!);
      if (mutation === "reordered") value.outcomes.reverse();
      if (mutation === "pass") value.outcomes[9]!.pass = 1;
      if (mutation === "name") value.outcomes[1]!.name += "/other";
      if (mutation === "extra-field") Object.assign(value.outcomes[1]!, { unexpected: true });
      if (mutation === "public") Object.assign(value.outcomes[0]!.outcome, { ownerSidValid: false });
      if (mutation === "private-code") Object.assign(value.outcomes[1]!.outcome, { code: "ENOTSUP" });
      if (mutation === "private-reason") Object.assign(value.outcomes[1]!.outcome, { message: reasons.nul });
      if (mutation === "private-type") Object.assign(value.outcomes[1]!.outcome, { isError: false });
      expect(() => validateQualification(value, loader())).toThrow();
      const measured = report();
      measured.metadata.nativeWindowsColonQualification = value;
      expect(() => validateReport(measured, filter, 20, 5)).toThrow();
    },
  );
});
