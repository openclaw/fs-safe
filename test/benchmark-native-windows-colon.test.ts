import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_WINDOWS_COLON_FILTER as filter,
  NATIVE_WINDOWS_COLON_NAMES as names,
  nativeWindowsColonDescriptors,
  ownerAndDaclBenchmark,
  registerNativeWindowsColon,
  validateNativeWindowsColonReport as validate,
  validateNativeWindowsColonReportSet as validateSet,
} from "../benchmarks/native-windows-colon.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";
import {
  nativeColonFacts as facts, nativeColonLoader as loader,
  nativeColonReport as report, nativeColonStudy as study,
} from "./helpers/native-windows-colon-qualification.js";

// All Windows/native observations below are synthetic; only input.json is real.
const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const reasons = {
  stream: "Windows filesystem path contains alternate stream syntax",
  nul: "Windows path contains a NUL byte",
};
const descriptors = nativeWindowsColonDescriptors();

type Registered = {
  name: string;
  run: () => unknown;
  options: {
    sync: boolean;
    expectError?: boolean;
    skip?: string;
    covers: string[];
    batch?: number;
    divisor?: number;
    before: () => void;
    after: (result: unknown) => void;
    workloadSemantics: string;
    workloadDetails: Record<string, unknown>;
    fixturePlacement: unknown;
  };
};

function nativeError(terminal: "stream" | "nul") {
  return Object.assign(new Error(reasons[terminal]), { code: "EINVAL" });
}

async function fixture(spelling = "ordinary-drive", component = "benchmark") {
  const workspace = await tempRoot("fs-safe-native-colon-unit-");
  const input = path.join(workspace, "input.json");
  fs.writeFileSync(input, '{"synthetic":true}\n');
  const windowsWorkspace = `${spelling === "ordinary-drive" ? "C:\\" : "\\\\?\\C:\\"}${component}`;
  const publicInput = path.win32.join(windowsWorkspace, "input.json");
  const mapInput = (value: unknown) => value === publicInput ? input : value;
  for (const method of ["lstatSync", "readFileSync", "statfsSync"] as const) {
    const original = fs[method];
    vi.spyOn(fs, method).mockImplementation((...args: unknown[]) => {
      const target = method === "statfsSync" && args[0] === windowsWorkspace ? workspace : mapInput(args[0]);
      return Reflect.apply(original, fs, [target, ...args.slice(1)]);
    });
  }
  const api = { readOwnerAndDacl: vi.fn((_pathname: string) => facts()) };
  const binding = {
    readOwnerAndDacl: vi.fn(function (this: unknown, pathname: string): never {
      expect(this).toBe(binding);
      throw nativeError(pathname.endsWith("\0") ? "nul" : "stream");
    }),
  };
  const original = ownerAndDaclBenchmark(api, publicInput, "win32");
  const originalAfter = vi.fn(original.options.after);
  const publicCase = { ...original, options: { ...original.options, after: originalAfter } };
  const rows: Registered[] = [];
  const parameters = {
    api, binding, native: true, nativeLoader: loader(), workspace: windowsWorkspace,
    args: { filter, mode: "require" }, publicCase, platform: "win32",
    register: (name: string, run: () => unknown, options: Registered["options"]) => rows.push({ name, run, options }),
  };
  return { input, publicInput, workspace, windowsWorkspace, api, binding, original, originalAfter, publicCase, rows, parameters };
}

type Report = ReturnType<typeof report>;

describe("native Windows colon benchmark registration", () => {
  it("prebuilds exactly eight rooted ASCII paths with actual terminal NULs", () => {
    expect(names).toHaveLength(9);
    expect(new Set(names).size).toBe(9);
    expect(descriptors.map((row: { name: string }) => row.name)).toEqual(names);
    expect(Object.isFrozen(descriptors)).toBe(true);
    for (const row of descriptors.slice(1)) {
      const { form, payloadBytes, terminal, inputBytes, inputCodeUnits, inputSha256 } = row.workloadDetails;
      const prefix = form === "ordinary-drive" ? "C:\\" : "\\\\?\\C:\\";
      const ending = terminal === "stream" ? ":stream" : "\0";
      expect(row.input).toBe(`${prefix}${"x".repeat(payloadBytes)}${ending}`);
      expect(Buffer.byteLength(row.input)).toBe(payloadBytes + prefix.length + ending.length);
      expect(inputBytes).toBe(Buffer.byteLength(row.input));
      expect(inputCodeUnits).toBe(row.input.length);
      expect(inputSha256).toBe(hash(row.input));
      expect(row.input.slice(prefix.length, -ending.length)).toBe("x".repeat(payloadBytes));
      expect(row.input.split("\0").length - 1).toBe(terminal === "nul" ? 1 : 0);
      expect(row.input.charCodeAt(row.input.length - 1)).toBe(terminal === "nul" ? 0 : "m".charCodeAt(0));
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.workloadDetails)).toBe(true);
    }
    expect(descriptors.slice(1).map((row: { workloadDetails: { inputBytes: number } }) => row.workloadDetails.inputBytes))
      .toEqual([26, 20, 4106, 4100, 30, 24, 4110, 4104]);
  });

  it("reuses the original public call/after and checks all synthetic calls outside execution", async () => {
    const f = await fixture();
    registerNativeWindowsColon(f.parameters);
    expect(f.rows.map(row => row.name)).toEqual(names);
    expect(f.rows[0]!.run).toBe(f.publicCase.run);
    expect(f.rows[0]!.options.covers).toEqual(["readOwnerAndDacl"]);
    expect(f.rows[0]!.options.expectError).toBeUndefined();
    for (let invocation = 0; invocation < 2; invocation++) {
      const publicRow = f.rows[0]!;
      publicRow.options.before();
      const result = publicRow.run();
      expect(f.originalAfter).toHaveBeenCalledTimes(invocation);
      publicRow.options.after(result);
      expect(f.originalAfter).toHaveBeenLastCalledWith(result);
      for (const [index, row] of f.rows.slice(1).entries()) {
        expect(row.options).toMatchObject({ sync: true, expectError: true, covers: [] });
        expect(row.options.batch).toBeUndefined();
        expect(row.options.divisor).toBeUndefined();
        row.options.before();
        let thrown: unknown;
        try { row.run(); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(Error);
        expect(() => row.options.after(thrown)).not.toThrow();
        expect(f.binding.readOwnerAndDacl).toHaveBeenLastCalledWith(descriptors[index + 1].input);
      }
    }
    expect(f.api.readOwnerAndDacl).toHaveBeenCalledTimes(2);
    expect(f.api.readOwnerAndDacl).toHaveBeenLastCalledWith(f.publicInput);
    expect(f.originalAfter).toHaveBeenCalledTimes(2);
    expect(f.binding.readOwnerAndDacl).toHaveBeenCalledTimes(16);
  });

  it.each(["ordinary-drive", "extended-drive"].flatMap(spelling => ["benchmark", "benchmark-é"].map(component => ({ spelling, component }))))(
    "records the actual $spelling $component public pathname without host normalization", async ({ spelling, component }) => {
    const f = await fixture(spelling, component);
    registerNativeWindowsColon(f.parameters);
    expect(f.rows[0]!.options.fixturePlacement).toMatchObject({
      inputUtf8Bytes: Buffer.byteLength(f.publicInput), inputUtf16CodeUnits: f.publicInput.length,
      inputSpelling: spelling, canonicalParentDepth: 1,
    });
    f.rows[0]!.options.before();
    const result = f.rows[0]!.run();
    f.rows[0]!.options.after(result);
    expect(f.api.readOwnerAndDacl).toHaveBeenLastCalledWith(f.publicInput);
    if (component.includes("é")) expect(Buffer.byteLength(f.publicInput)).toBe(f.publicInput.length + 1);
  });

  it.each(["relative", "C:relative", "\\\\server\\share", "\\\\?\\UNC\\server\\share", "C:\\benchmark\0",
    "K:\\benchmark", "\\\\?\\ſ:\\benchmark"])(
    "rejects unsupported public workspace spelling %s before any API call", async workspace => {
      const f = await fixture();
      expect(() => registerNativeWindowsColon({ ...f.parameters, workspace })).toThrow(
        workspace.includes("\0") ? "public input contains NUL" : "not a rooted drive spelling",
      );
      expect(f.rows).toEqual([]);
      expect(f.api.readOwnerAndDacl).not.toHaveBeenCalled();
      expect(f.binding.readOwnerAndDacl).not.toHaveBeenCalled();
    },
  );

  it("retains every original owner/DACL success assertion", () => {
    const api = { readOwnerAndDacl: vi.fn(() => facts()) };
    const original = ownerAndDaclBenchmark(api, "synthetic-input", "win32");
    expect(original.options.sync).toBe(true);
    expect(original.options.skip).toBeUndefined();
    for (const change of [
      { status: "unsupported-platform" }, { isLocal: false }, { complete: false },
      { daclPresent: false }, { unsupportedAceTypes: [7] }, { ownerSid: "invalid" }, { currentUserSid: "invalid" },
    ]) expect(() => original.options.after({ ...facts(), ...change })).toThrow();
    expect(ownerAndDaclBenchmark(api, "synthetic-input", "linux").options.skip).toContain("requires Windows");
    expect(api.readOwnerAndDacl).not.toHaveBeenCalled();
  });

  it("rejects wrong private error values, codes and reasons after every row", async () => {
    const f = await fixture();
    registerNativeWindowsColon(f.parameters);
    for (const row of f.rows.slice(1)) {
      const message = row.options.workloadDetails.expectedReason as string;
      for (const wrong of [undefined, null, false, message, { code: "EINVAL", message },
        new Error(message), Object.assign(new Error(message), { code: "ENOTSUP" }),
        Object.assign(new Error("wrong reason"), { code: "EINVAL", reason: message })]) {
        expect(() => row.options.after(wrong)).toThrow();
      }
      expect(() => row.options.after(Object.assign(new Error(message), { code: "EINVAL" }))).not.toThrow();
    }
    expect(f.binding.readOwnerAndDacl).not.toHaveBeenCalled();
  });

  it("rejects a changed binding both before and after an invocation", async () => {
    const f = await fixture();
    registerNativeWindowsColon(f.parameters);
    f.binding.readOwnerAndDacl = vi.fn((): never => { throw nativeError("stream"); });
    for (const [index, row] of f.rows.entries()) {
      expect(() => row.options.before()).toThrow("binding method changed");
      const result = index === 0 ? facts() : Object.assign(new Error(row.options.workloadDetails.expectedReason as string), { code: "EINVAL" });
      expect(() => row.options.after(result)).toThrow("binding method changed");
    }
  });

  it("rejects replacement of the public API method before and after the success row", async () => {
    const f = await fixture();
    registerNativeWindowsColon(f.parameters);
    f.api.readOwnerAndDacl = vi.fn(() => facts());
    expect(() => f.rows[0]!.options.before()).toThrow("public method changed");
    expect(() => f.rows[0]!.options.after(facts())).toThrow("public method changed");
    expect(f.api.readOwnerAndDacl).not.toHaveBeenCalled();
  });

  it.each(["contents", "identity", "kind"])("rejects public fixture %s mutation before and after", async mutation => {
    const f = await fixture();
    registerNativeWindowsColon(f.parameters);
    if (mutation === "contents") fs.writeFileSync(f.input, "changed");
    else {
      fs.renameSync(f.input, `${f.input}.original`);
      if (mutation === "identity") fs.copyFileSync(`${f.input}.original`, f.input);
      else fs.mkdirSync(f.input);
    }
    expect(() => f.rows[0]!.options.before()).toThrow();
    expect(() => f.rows[0]!.options.after(facts())).toThrow();
    expect(f.api.readOwnerAndDacl).not.toHaveBeenCalled();
  });

  it.each(["", "readOwnerAndDacl", "native-windows-colon", `${filter}private-admission`])(
    "does not register or inspect anything for the non-opt-in filter %s", selectedFilter => {
      const register = vi.fn();
      registerNativeWindowsColon({ args: { filter: selectedFilter, mode: "off" }, platform: "linux", register,
        workspace: "unused", api: {}, binding: undefined, native: false, nativeLoader: undefined });
      expect(register).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["platform", { platform: "linux" }], ["mode", { args: { filter, mode: "off" } }],
    ["auto mode", { args: { filter, mode: "auto" } }], ["native flag", { native: false }],
    ["missing binding", { binding: undefined }], ["missing method", { binding: {} }],
    ["invalid method", { binding: { readOwnerAndDacl: "invalid" } }], ["missing loader", { nativeLoader: undefined }],
    ["missing public export", { api: {} }],
  ])("fails registration for %s", async (_label, change) => {
    const f = await fixture();
    expect(() => registerNativeWindowsColon({ ...f.parameters, ...change })).toThrow();
    expect(f.rows).toEqual([]);
    expect(f.api.readOwnerAndDacl).not.toHaveBeenCalled();
    expect(f.binding.readOwnerAndDacl).not.toHaveBeenCalled();
  });

  it("requires every exact loader field before registration", async () => {
    const f = await fixture();
    for (const field of Object.keys(loader())) {
      const invalid = loader();
      Reflect.deleteProperty(invalid, field);
      expect(() => registerNativeWindowsColon({ ...f.parameters, nativeLoader: invalid })).toThrow();
    }
    for (const change of [
      { mechanism: "guessed path" }, { loaderModule: "other.js" }, { bindingMethod: "other" },
      { addonRelativePath: "native/other.node" }, { addonBasename: "other.node" },
      { addonSha256: "invalid" }, { loaderSha256: "invalid" }, { addonBytes: 0 },
      { addonBytes: 1.5 }, { modulesAbi: "0" }, { napiVersion: "" }, { extra: true },
    ]) expect(() => registerNativeWindowsColon({ ...f.parameters, nativeLoader: { ...loader(), ...change } })).toThrow();
    expect(f.rows).toEqual([]);
  });
});

describe("native Windows colon report admission", () => {
  it("accepts exactly the declared family and ignores unrelated empty reports", () => {
    expect(() => validate(report(), filter, 20, 5)).not.toThrow();
    expect(() => validate({ results: [] }, "readOwnerAndDacl", 20, 5)).not.toThrow();
    expect(() => validate(report(), "readOwnerAndDacl", 20, 5)).toThrow("row set mismatch");
  });

  it.each(["missing", "duplicate", "reordered", "unknown", "disguised", "extra", "skipped"])(
    "rejects %s rows", mutation => {
      const value = report();
      if (mutation === "missing") value.results.pop();
      if (mutation === "duplicate") value.results.push(value.results[0]!);
      if (mutation === "reordered") value.results.reverse();
      if (mutation === "unknown") value.results[1]!.name += "/unknown";
      if (mutation === "disguised") value.results.push({ ...value.results[1]!, name: `other/${value.results[1]!.name}` });
      if (mutation === "extra") value.results.push({ ...value.results[0]!, name: "unrelated" });
      if (mutation === "skipped") Object.assign(value.results[1]!, { skipped: "unsupported" });
      expect(() => validate(value, filter, 20, 5)).toThrow();
    },
  );

  it("rejects changed workload, placement, iterations and sample counts", () => {
    const mutations: Array<(value: Report) => void> = [
      value => { value.results[1]!.iterations = 19; },
      value => { value.results[1]!.samplesUs.pop(); },
      value => { value.results[1]!.workloadSemantics = "successful call"; },
      value => { value.results[1]!.workloadDetails = { wrong: true }; },
      value => { value.results[1]!.fixturePlacement = "different route"; },
      value => { Object.assign(value.results[0]!.fixturePlacement, { kind: "new fixture" }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { bytes: 0 }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { sha256: "invalid" }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { canonicalParentDepth: 0 }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { inputUtf8Bytes: 0 }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { inputUtf8Bytes: 1.5 }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { inputUtf16CodeUnits: 0 }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { inputSpelling: "drive-relative" }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { filesystemType: 2 }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { filesystemBlockSize: 8192 }); },
      value => { Object.assign(value.results[0]!.fixturePlacement, { extra: true }); },
    ];
    for (const mutate of mutations) {
      const value = report();
      mutate(value);
      expect(() => validate(value, filter, 20, 5)).toThrow();
    }
  });

  it("rejects uniformly absent, null, empty and incorrectly typed environments", () => {
    for (const field of ["node", "platform", "arch", "cpu", "osRelease"]) {
      for (const invalid of [undefined, null, "", "  ", 24, [], {}]) {
        const value = report();
        if (invalid === undefined) Reflect.deleteProperty(value.metadata, field);
        else Object.assign(value.metadata, { [field]: invalid });
        expect(() => validate(value, filter, 20, 5)).toThrow();
        const s = study();
        for (const file of s.reports.keys()) s.reports.set(file, structuredClone(value));
        expect(() => validateSet(s.plan, s.reports, s.before)).toThrow();
      }
    }
    for (const invalid of [undefined, null, "", [], {}]) {
      expect(() => validate({ ...report(), metadata: invalid }, filter, 20, 5)).toThrow();
    }
    for (const invalid of [undefined, null, "", [], {}, { type: 1 }, { blockSize: 4096 },
      { type: "1", blockSize: 4096 }, { type: 1.5, blockSize: 4096 },
      { type: 1, blockSize: 0 }, { type: 1, blockSize: Infinity }]) {
      const value = report();
      Object.assign(value.metadata, { workspaceFilesystem: invalid });
      expect(() => validate(value, filter, 20, 5)).toThrow();
      const s = study();
      for (const file of s.reports.keys()) s.reports.set(file, structuredClone(value));
      expect(() => validateSet(s.plan, s.reports, s.before)).toThrow();
    }
  });

  it("requires Windows x64, require mode and a matching complete loader receipt", () => {
    for (const change of [{ platform: "linux" }, { arch: "arm64" }, { mode: "off" }, { native: false },
      { nativeHash: "b".repeat(64) }, { nativeLoader: null }]) {
      const value = report();
      Object.assign(value.metadata, change);
      expect(() => validate(value, filter, 20, 5)).toThrow();
    }
    for (const field of Object.keys(loader())) {
      const value = report();
      Reflect.deleteProperty(value.metadata.nativeLoader, field);
      expect(() => validate(value, filter, 20, 5)).toThrow();
    }
  });

  it("accepts per-source native artifacts and same-artifact measurement-role aliasing", () => {
    for (const sameArtifact of [false, true]) {
      const s = study(sameArtifact);
      expect(() => validateSet(s.plan, s.reports, s.before)).not.toThrow();
      if (sameArtifact) {
        expect(s.plan.reports[0]!.role).toBe("baseline");
        expect(s.plan.reports.every(spec => spec.buildId === "candidate-build")).toBe(true);
        expect(s.reports.get(s.plan.reports[0]!.file)!.metadata).toMatchObject({
          measuredDistribution: { sourceRole: "candidate", buildId: "candidate-build" },
        });
      }
    }
  });

  it.each(["environment", "fixture", "input UTF-8 bytes", "input UTF-16 units", "input spelling", "loader", "ABI", "addon"])("rejects %s drift within a measured build", mutation => {
    const s = study();
    const value = s.reports.get(s.plan.reports[2]!.file)!;
    if (mutation === "environment") value.metadata.cpu = "Different CPU";
    if (mutation === "fixture") Object.assign(value.results[0]!.fixturePlacement, { bytes: 20 });
    if (mutation === "input UTF-8 bytes") Object.assign(value.results[0]!.fixturePlacement, { inputUtf8Bytes: 24 });
    if (mutation === "input UTF-16 units") Object.assign(value.results[0]!.fixturePlacement, { inputUtf16CodeUnits: 24 });
    if (mutation === "input spelling") Object.assign(value.results[0]!.fixturePlacement, { inputSpelling: "extended-drive" });
    if (mutation === "loader") value.metadata.nativeLoader.loaderSha256 = "f".repeat(64);
    if (mutation === "ABI") value.metadata.nativeLoader.modulesAbi = "138";
    if (mutation === "addon") {
      value.metadata.nativeLoader.addonSha256 = "f".repeat(64);
      value.metadata.nativeHash = "f".repeat(64);
    }
    expect(() => validateSet(s.plan, s.reports, s.before)).toThrow();
  });

  it("rejects absent reports, incomplete plan/build metadata and mismatched Windows artifact receipts", () => {
    const missing = study();
    missing.reports.delete(missing.plan.reports[0]!.file);
    expect(() => validateSet(missing.plan, missing.reports, missing.before)).toThrow();
    for (const change of [{ path: "native/other.node" }, { size: 4095 }, { sha256: "f".repeat(64) }]) {
      const s = study();
      Object.assign(s.before.builds["candidate-build"]!.nativeArtifacts[0]!, change);
      expect(() => validateSet(s.plan, s.reports, s.before)).toThrow("not the staged Windows artifact");
    }
    for (const [field, value] of [["planHash", undefined], ["planHash", "0".repeat(64)], ["installationSchemaVersion", undefined], ["runnerDistHash", "invalid"], ["distTreeHash", undefined]] as const) {
      const s = study(), target = field === "planHash" ? s.plan : s.before.builds["candidate-build"]!;
      Object.assign(target, { [field]: value });
      expect(() => validateSet(s.plan, s.reports, s.before)).toThrow();
    }
  });

  it.each(["harness", "baseline-build", "candidate-build"])("requires complete bounded dependency metadata for %s", target => {
    for (const change of [
      { schemaVersion: 0 }, { scope: "unknown" }, { hash: "invalid" },
      { entries: 0 }, { entries: 100_001 }, { entries: 1.5 },
      { hashedBytes: 0 }, { hashedBytes: 128 * 1024 * 1024 + 1 },
      { limits: {} }, { limitation: "" }, { limitation: " " }, { limitation: null },
    ]) {
      const s = study();
      const owner = target === "harness" ? s.before.harness : s.before.builds[target]!;
      Object.assign(owner.dependencySnapshot, change);
      expect(() => validateSet(s.plan, s.reports, s.before)).toThrow();
    }
    for (const invalid of [undefined, null, {}]) {
      const s = study();
      const owner = target === "harness" ? s.before.harness : s.before.builds[target]!;
      Object.assign(owner, { dependencySnapshot: invalid });
      expect(() => validateSet(s.plan, s.reports, s.before)).toThrow();
    }
  });
});
