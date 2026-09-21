import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadArchive } from "../.github/actions/setup-archive-llvm/download.mjs";

const { delay } = vi.hoisted(() => ({ delay: vi.fn<(ms: number) => Promise<void>>() }));
vi.mock("node:timers/promises", () => ({ setTimeout: delay }));

const bytes = Buffer.from("small verified archive fixture");
const hash = createHash("sha256").update(bytes).digest("hex");
const url = "https://example.invalid/sdk.tar.gz";
let directory: string;
let archive: string;
let request: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fs-safe-llvm-setup-"));
  archive = join(directory, "sdk.tar.gz");
  request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  delay.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function rejected(status: number, cancel = vi.fn()) {
  return new Response(new ReadableStream({ cancel }), { status });
}

it.each([408, 500, 502, 503, 504])("disposes HTTP %i before retrying the same verified download", async (status) => {
  const events: string[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout");
  request.mockImplementationOnce(async () => rejected(status, () => { events.push("cancel"); }));
  request.mockImplementationOnce(async () => {
    events.push("fetch-again");
    return new Response(bytes);
  });
  delay.mockImplementation(async (ms) => { events.push(`wait:${ms}`); });

  await downloadArchive(url, archive, hash, "fixture-sdk");

  expect(events).toEqual(["cancel", "wait:1000", "fetch-again"]);
  expect(await readFile(archive)).toEqual(bytes);
  expect(request.mock.calls.map(([address]) => address)).toEqual([url, url]);
  const signals = request.mock.calls.map(([, options]) => options?.signal);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(signals[0]).not.toBe(signals[1]);
  expect(timeout.mock.calls).toEqual([[180_000], [180_000]]);
});

it.each(["throw", "reject"])("stops after three HTTP failures when body disposal can %s", async (mode) => {
  const cancel = vi.fn(() => {
    if (mode === "throw") throw new Error("body disposal failed");
    return Promise.reject(new Error("body disposal failed"));
  });
  request.mockImplementation(async () => {
    const response = rejected(504);
    Object.defineProperty(response.body, "cancel", { value: cancel });
    return response;
  });

  await expect(downloadArchive(url, archive, hash, "fixture-sdk")).rejects.toThrow("LLVM download failed: HTTP 504");

  expect(request).toHaveBeenCalledTimes(3);
  expect(cancel).toHaveBeenCalledTimes(3);
  expect(delay.mock.calls).toEqual([[1000], [2000]]);
  expect(await readdir(directory)).toEqual([]);
});

it.each([401, 403, 404, 429, 501])("does not retry HTTP %i", async (status) => {
  const cancel = vi.fn();
  request.mockResolvedValue(rejected(status, cancel));

  await expect(downloadArchive(url, archive, hash, "fixture-sdk")).rejects.toThrow(`HTTP ${status}`);

  expect(request).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it("does not retry an accepted response without a body", async () => {
  request.mockResolvedValue(new Response(null));
  await expect(downloadArchive(url, archive, hash, "fixture-sdk")).rejects.toThrow("HTTP 200");
  expect(request).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

it("does not retry a rejected fetch", async () => {
  const error = new Error("network failure");
  request.mockRejectedValue(error);
  await expect(downloadArchive(url, archive, hash, "fixture-sdk")).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

it("does not retry a failing response stream", async () => {
  const error = new Error("stream failure");
  request.mockResolvedValue(new Response(new ReadableStream({
    start(controller) { controller.error(error); },
  })));
  await expect(downloadArchive(url, archive, hash, "fixture-sdk")).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

it("preserves an existing archive instead of overwriting or retrying it", async () => {
  await writeFile(archive, "existing archive");
  request.mockResolvedValue(new Response(bytes));
  await expect(downloadArchive(url, archive, hash, "fixture-sdk")).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(archive, "utf8")).toBe("existing archive");
  expect(request).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

it("does not retry a checksum mismatch", async () => {
  request.mockResolvedValue(new Response("different bytes"));
  await expect(downloadArchive(url, archive, hash, "fixture-sdk")).rejects.toThrow("LLVM checksum mismatch: fixture-sdk");
  expect(request).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

it.skipIf(!["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"].includes(`${process.platform}-${process.arch}`))(
  "keeps the actual installer from extracting or publishing a bad checksum after retry",
  async () => {
    const runner = join(directory, "runner");
    const environment = join(directory, "github-env");
    const trace = join(directory, "trace.jsonl");
    const preload = join(directory, "preload.mjs");
    await mkdir(runner);
    await writeFile(join(runner, "keep"), "unrelated runner file");
    await writeFile(environment, "original environment\n");
    await writeFile(preload, `
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
const trace = (event) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(event) + "\\n");
let attempts = 0;
globalThis.fetch = async (url) => {
  trace({ event: "fetch", url });
  return ++attempts === 1
    ? new Response(new ReadableStream({ cancel() { trace({ event: "cancel" }); } }), { status: 504 })
    : new Response("not the checksum-pinned LLVM SDK");
};
timers.setTimeout = async (ms) => { trace({ event: "wait", ms }); };
childProcess.spawnSync = () => { trace({ event: "spawn" }); throw new Error("unexpected extraction or probe"); };
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(preload).href,
      fileURLToPath(new URL("../.github/actions/setup-archive-llvm/install.mjs", import.meta.url)),
    ], {
      env: { ...process.env, RUNNER_TEMP: runner, GITHUB_ENV: environment },
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LLVM checksum mismatch:");
    const events = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map(({ event }) => event)).toEqual(["fetch", "cancel", "wait", "fetch"]);
    expect(events[2].ms).toBe(1000);
    expect(events[0].url).toBe(events[3].url);
    expect(events[0].url).toMatch(/^https:\/\/github\.com\/WebAssembly\/wasi-sdk\/releases\/download\/wasi-sdk-34\/wasi-sdk-34\.0-.+\.tar\.gz$/);
    expect(await readFile(environment, "utf8")).toBe("original environment\n");
    expect(await readdir(runner)).toEqual(["keep"]);
    expect(await readFile(join(runner, "keep"), "utf8")).toBe("unrelated runner file");
  },
  10_000,
);
