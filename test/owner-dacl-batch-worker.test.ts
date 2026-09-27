import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ binding: undefined as undefined | { readOwnerAndDacl?: ReturnType<typeof vi.fn> } }));
vi.mock("../src/native.js", () => ({ getNativeBinding: () => native.binding }));

// Execute the real child entrypoint in the instrumented process. Its production
// stdin/stdout protocol and budgets stay intact; only the OS inspection is stubbed.
async function run(chunks: (Buffer | string)[], mode = "auto") {
  vi.resetModules();
  vi.stubEnv("FS_SAFE_OWNER_DACL_BATCH_MODE", mode);
  const input = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(chunks) as typeof process.stdin);
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
  try { await import("../src/owner-dacl-batch-worker.js"); }
  finally { input.mockRestore(); write.mockRestore(); }
  expect(output).toHaveLength(1);
  return JSON.parse(output[0]!);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); native.binding = undefined; });

it.each(["auto", "require"])("preserves ordered inspection results in %s mode", async mode => {
  const security = { ownerSid: "S-1-5-18", dacl: [] };
  const inspect = vi.fn(function (this: unknown, pathname: string) {
    expect(this).toBe(native.binding);
    return { ...security, pathname };
  });
  native.binding = { readOwnerAndDacl: inspect };
  const paths = ["C:\\first", "C:\\second"];
  const input = JSON.stringify(paths);
  expect(await run([input.slice(0, 5), Buffer.from(input.slice(5))], mode)).toEqual({
    ok: true, result: paths.map(path => ({ path, security: { ...security, pathname: path } })),
  });
  expect(inspect.mock.calls.map(([path]) => path)).toEqual(paths);
});

it("accepts an empty batch without native calls", async () => {
  const inspect = vi.fn(); native.binding = { readOwnerAndDacl: inspect };
  expect(await run(["[]"])).toEqual({ ok: true, result: [] });
  expect(inspect).not.toHaveBeenCalled();
});

it.each(["off", "", "invalid"])("refuses disabled or invalid mode %j before inspection", async mode => {
  expect(await run(["[]"], mode)).toMatchObject({ ok: false, code: "helper-unavailable", message: expect.stringContaining("not enabled") });
});

it.each(["{}", '[null]', '[""]', '["nul\\u0000path"]', '[1]', 'not json'])("rejects invalid input %s", async input => {
  const inspect = vi.fn(); native.binding = { readOwnerAndDacl: inspect };
  expect(await run([input])).toMatchObject({ ok: false, code: "EIO" });
  expect(inspect).not.toHaveBeenCalled();
});

it("rejects malformed UTF-8 instead of inspecting a replacement spelling", async () => {
  const inspect = vi.fn(); native.binding = { readOwnerAndDacl: inspect };
  expect(await run([Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d])])).toMatchObject({ ok: false, code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  expect(inspect).not.toHaveBeenCalled();
});

it("bounds aggregate input before parsing or inspection", async () => {
  const inspect = vi.fn(); native.binding = { readOwnerAndDacl: inspect };
  expect(await run([Buffer.alloc(16 * 1024 * 1024), "x"])).toMatchObject({ ok: false, code: "EIO", message: expect.stringContaining("input budget") });
  expect(inspect).not.toHaveBeenCalled();
});

it.each([undefined, {}])("reports a missing native inspector", async binding => {
  native.binding = binding;
  expect(await run(['["C:\\\\file"]'])).toMatchObject({ ok: false, code: "helper-unavailable" });
});

it.each([null, undefined, "failed", { code: 42 }, { code: "EACCES" }])("serializes an inspection failure safely (%j)", async error => {
  const inspect = vi.fn(() => { throw error; }); native.binding = { readOwnerAndDacl: inspect };
  expect(await run([JSON.stringify(["C:\\file", "C:\\later"])])).toMatchObject({
    ok: false, code: error && typeof error === "object" && typeof error.code === "string" ? error.code : "EIO",
    message: expect.any(String),
  });
  expect(inspect).toHaveBeenCalledTimes(1);
});

it("rejects an oversized output without returning partial results", async () => {
  const inspect = vi.fn(() => "x".repeat(16 * 1024 * 1024)); native.binding = { readOwnerAndDacl: inspect };
  expect(await run([JSON.stringify(["C:\\file", "C:\\later"])])).toMatchObject({ ok: false, code: "too-large", message: expect.stringContaining("output budget") });
  expect(inspect).toHaveBeenCalledTimes(1);
});
