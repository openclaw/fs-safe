import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCloneFileMetadata } from "../src/copy.js";
import { readDarwinCloneFileMetadata } from "../src/darwin-clone-metadata.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: execFileMock,
}));

type CommandCallback = (error: Error | null, stdout: string, stderr: string) => void;
type Command = {
  file: string;
  args: string[];
  options: ExecFileOptionsWithStringEncoding;
  callback: CommandCallback;
  stdin: PassThrough | null;
  input: string;
  kill: ReturnType<typeof vi.fn>;
};
const commands: Command[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const posixNormalize = path.posix.normalize;
const platformPathFunctions = {
  posix: { normalize: posixNormalize, isAbsolute: path.posix.isAbsolute },
  win32: { normalize: path.win32.normalize, isAbsolute: path.win32.isAbsolute },
};

function spoofPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  const functions = platformPathFunctions[platform === "win32" ? "win32" : "posix"];
  vi.spyOn(path, "normalize").mockImplementation((value) => functions.normalize(value));
  vi.spyOn(path, "isAbsolute").mockImplementation((value) => functions.isAbsolute(value));
}

function reply(command: Command, results: (Buffer | null)[]): void {
  command.callback(null, JSON.stringify({
    version: 1,
    results: results.map((value) => value?.toString("base64") ?? null),
  }), "");
}

function arrange(
  onInput: (command: Command) => void = () => {},
  prepare: (command: Command) => void = () => {},
): void {
  execFileMock.mockImplementation((
    file: string, args: string[], options: ExecFileOptionsWithStringEncoding, callback: CommandCallback,
  ) => {
    const stdin = new PassThrough();
    const command: Command = { file, args, options, callback, stdin, input: "", kill: vi.fn(() => true) };
    commands.push(command);
    stdin.on("data", (chunk: Buffer) => { command.input += chunk.toString("utf8"); });
    stdin.once("finish", () => onInput(command));
    prepare(command);
    return { stdin: command.stdin, kill: command.kill };
  });
}

function metadata(): Buffer {
  const value = Buffer.alloc(100);
  value.writeUInt32LE(100, 0);
  value.writeUInt32LE(0x82038c0a, 4);
  value.writeUInt32LE(0x200, 16);
  value.writeUInt32LE(0x100, 20);
  value.writeUInt32LE(0xfedcba98, 24);
  value.writeUInt32LE(1, 28);
  value.writeBigInt64LE(-1234n, 32);
  value.writeBigInt64LE(987654321n, 40);
  value.writeBigInt64LE(123456n, 48);
  value.writeBigInt64LE(123456789n, 56);
  value.writeUInt32LE(501, 64);
  value.writeUInt32LE(20, 68);
  value.writeUInt32LE(0o100600, 72);
  value.writeBigUInt64LE((1n << 63n) + 7n, 76);
  value.writeBigUInt64LE((1n << 53n) + 9n, 84);
  value.writeBigUInt64LE((1n << 64n) - 1n, 92);
  return value;
}

function portableApi(): void {
  spoofPlatform("darwin");
  configureFsSafeNative({ mode: "off" });
  __setNativeLoaderForTest(() => { throw new Error("native loader must not run"); });
}

beforeEach(() => {
  commands.length = 0;
  execFileMock.mockReset();
  __resetNativeFallbackWarningsForTest();
});
afterEach(() => {
  for (const command of commands) command.stdin?.destroy();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __resetNativeFallbackWarningsForTest();
});

describe("Darwin clone metadata command protocol", () => {
  it("uses one fixed program and bounded execution, with raw pathname spelling only in JSON stdin", async () => {
    const paths = ["/raw/link/../name", "/quotes'\"$`\\\n\r\u2028日本語😀", "/--argument"];
    arrange((command) => reply(command, JSON.parse(command.input).map(() => null)));
    await expect(readDarwinCloneFileMetadata(paths)).resolves.toEqual([null, null, null]);
    await expect(readDarwinCloneFileMetadata(["/different"])).resolves.toEqual([null]);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.file).toBe("/usr/bin/osascript");
    expect(commands[0]!.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(commands[0]!.args).toHaveLength(4);
    expect(commands[0]!.args).toEqual(commands[1]!.args);
    expect(commands[0]!.input).toBe(JSON.stringify(paths));
    expect(JSON.parse(commands[0]!.input)).toEqual(paths);
    for (const pathname of paths) expect(commands[0]!.args.join(" ")).not.toContain(pathname);
    expect(commands[0]!.options).toMatchObject({
      encoding: "utf8", cwd: "/", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    expect(Object.keys(commands[0]!.options.env!)).toEqual(["PATH"]);
    expect(commands[0]!.options.shell).toBeUndefined();
  });

  it("batches at 128 paths while retaining repeated entries and per-entry nulls in order", async () => {
    const paths = Array.from({ length: 270 }, (_, index) => `/item-${index % 131}`);
    const expected = paths.map((pathname) => {
      const index = Number(pathname.slice(6));
      return index % 7 === 0 ? null : Buffer.alloc(100, index);
    });
    arrange((command) => reply(command, JSON.parse(command.input).map((pathname: string) => {
      const index = Number(pathname.slice(6));
      return index % 7 === 0 ? null : Buffer.alloc(100, index);
    })));
    await expect(readDarwinCloneFileMetadata(paths)).resolves.toEqual(expected);
    expect(commands.map((command) => JSON.parse(command.input).length)).toEqual([128, 128, 14]);
    expect(commands.flatMap((command) => JSON.parse(command.input))).toEqual(paths);
  });

  it("matches Node UTF-8 replacement of lone surrogates while retaining valid pairs", async () => {
    const paths = ["/high-\ud800", "/low-\udfff", "/pair-\ud83d\ude00", "/mixed-\ud800\ud800\udc00"];
    const expected = ["/high-\ufffd", "/low-\ufffd", "/pair-😀", "/mixed-\ufffd\ud800\udc00"];
    arrange((command) => reply(command, JSON.parse(command.input).map(() => null)));
    await expect(readDarwinCloneFileMetadata(paths)).resolves.toEqual([null, null, null, null]);
    expect(JSON.parse(commands[0]!.input)).toEqual(expected);
    expect(commands[0]!.input).toBe(JSON.stringify(expected));
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it.each(["UTF-8", "JSON escapes"])("batches by actual serialized %s bytes below 64 KiB", async (kind) => {
    const suffix = kind === "UTF-8" ? "é".repeat(480) : "\u0001".repeat(700);
    const paths = Array.from({ length: 90 }, (_, index) => `/entry-${index}/${suffix}`);
    const expected = paths.map((_, index) => index % 11 === 0 ? null : Buffer.alloc(100, index));
    const byPath = new Map(paths.map((pathname, index) => [pathname, expected[index]!]));
    arrange((command) => reply(command, JSON.parse(command.input).map((pathname: string) => byPath.get(pathname)!)));
    await expect(readDarwinCloneFileMetadata(paths)).resolves.toEqual(expected);
    expect(commands.length).toBeGreaterThan(1);
    expect(commands.flatMap((command) => JSON.parse(command.input))).toEqual(paths);
    for (const [index, command] of commands.entries()) {
      expect(Buffer.byteLength(command.input)).toBeLessThanOrEqual(64 * 1024);
      const batch: string[] = JSON.parse(command.input);
      expect(batch.length).toBeLessThan(128);
      if (commands[index + 1]) {
        const next: string[] = JSON.parse(commands[index + 1]!.input);
        expect(Buffer.byteLength(JSON.stringify([...batch, next[0]]))).toBeGreaterThan(64 * 1024);
      }
    }
  });

  it("does not spawn for empty input or paths at or above Darwin's UTF-8 byte limit", async () => {
    const atLimit = `/${"é".repeat(511)}x`;
    const aboveLimit = `/${"😀".repeat(256)}`;
    expect(Buffer.byteLength(atLimit)).toBe(1024);
    await expect(readDarwinCloneFileMetadata([])).resolves.toEqual([]);
    await expect(readDarwinCloneFileMetadata([atLimit, aboveLimit])).resolves.toEqual([null, null]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("accepts 1023-byte paths and leaves skipped oversized entries in their original positions", async () => {
    const boundary = `/${"é".repeat(511)}`;
    const tooLong = `${boundary}x`;
    arrange((command) => reply(command, JSON.parse(command.input).map(() => metadata())));
    await expect(readDarwinCloneFileMetadata([tooLong, boundary, "/short", tooLong, boundary]))
      .resolves.toEqual([null, metadata(), metadata(), null, metadata()]);
    expect(JSON.parse(commands[0]!.input)).toEqual([boundary, "/short", boundary]);
    expect(Buffer.byteLength(boundary)).toBe(1023);
  });

  it.each(["relative", "", "/with\0nul", null, 123])("rejects invalid path %j before spawning", async (pathname) => {
    await expect(readDarwinCloneFileMetadata([pathname as string])).rejects.toMatchObject({ code: "invalid-path" });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  const canonical = Buffer.alloc(100).toString("base64");
  const noncanonical = `${canonical.slice(0, -3)}B==`;
  it("rejects noncanonical pad bits even when they decode to the expected 100 bytes", async () => {
    expect(Buffer.from(noncanonical, "base64")).toEqual(Buffer.alloc(100));
    arrange((command) => command.callback(null, JSON.stringify({ version: 1, results: [noncanonical] }), ""));
    await expect(readDarwinCloneFileMetadata(["/file"])).rejects.toMatchObject({ code: "helper-failed" });
  });

  it.each([
    ["empty", ""], ["invalid JSON", "not-json"], ["truncated", '{"version":1,"results":['],
    ["null", "null"], ["array", "[]"], ["scalar", "1"],
    ["missing version", '{"results":[null]}'], ["missing results", '{"version":1}'],
    ["wrong version", '{"version":2,"results":[null]}'],
    ["string version", '{"version":"1","results":[null]}'],
    ["extra key", '{"version":1,"results":[null],"extra":0}'],
    ["non-array results", '{"version":1,"results":{}}'],
    ["missing entry", '{"version":1,"results":[]}'],
    ["extra entry", '{"version":1,"results":[null,null]}'],
    ["invalid entry", '{"version":1,"results":[false]}'],
    ["short payload", JSON.stringify({ version: 1, results: [Buffer.alloc(99).toString("base64")] })],
    ["oversized payload", JSON.stringify({ version: 1, results: [Buffer.alloc(101).toString("base64")] })],
    ["invalid base64", JSON.stringify({ version: 1, results: ["!".repeat(136)] })],
    ["missing padding", JSON.stringify({ version: 1, results: [canonical.slice(0, -2)] })],
  ])("rejects %s replies as helper-failed", async (_name, stdout) => {
    arrange((command) => command.callback(null, stdout, ""));
    await expect(readDarwinCloneFileMetadata(["/file"])).rejects.toMatchObject({ code: "helper-failed" });
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it("rejects stderr even with a complete successful reply", async () => {
    arrange((command) => command.callback(null, '{"version":1,"results":[null]}', "unexpected diagnostics"));
    await expect(readDarwinCloneFileMetadata(["/file"])).rejects.toMatchObject({ code: "helper-failed" });
  });

  it("rejects the whole request and stops batching after an incomplete later reply", async () => {
    arrange((command) => {
      if (commands.length === 1) reply(command, JSON.parse(command.input).map(() => metadata()));
      else command.callback(null, '{"version":1,"results":[]}', "");
    });
    const paths = Array.from({ length: 300 }, (_, index) => `/file-${index}`);
    await expect(readDarwinCloneFileMetadata(paths)).rejects.toMatchObject({ code: "helper-failed" });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("Darwin clone metadata process lifetime", () => {
  it("converts synchronous spawn failures without retrying", async () => {
    const failure = Object.assign(new Error("spawn unavailable"), { code: "ENOENT" });
    execFileMock.mockImplementation(() => { throw failure; });
    await expect(readDarwinCloneFileMetadata(["/file"])).rejects.toMatchObject({ code: "helper-failed", cause: failure });
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it.each(["exit", "spawn", "timeout", "overflow"])("settles %s failures only after execFile completion", async (kind) => {
    arrange();
    const pending = readDarwinCloneFileMetadata(["/file"]);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    const failure = Object.assign(new Error(`${kind} failed`), kind === "timeout"
      ? { killed: true, signal: "SIGKILL" }
      : { code: kind === "overflow" ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : kind === "spawn" ? "ENOENT" : 1 });
    commands[0]!.callback(failure, kind === "overflow" ? "x".repeat(65_537) : "", "");
    await expect(pending).rejects.toMatchObject({ code: "helper-failed", cause: failure });
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it.each(["EPIPE", "missing stdin", "throwing end"])("kills on %s and waits for child completion", async (kind) => {
    const failure = Object.assign(new Error("input failed"), { code: "EPIPE" });
    arrange(() => {}, (command) => {
      if (kind === "missing stdin") command.stdin = null;
      if (kind === "throwing end") vi.spyOn(command.stdin!, "end").mockImplementation(() => { throw failure; });
    });
    const pending = readDarwinCloneFileMetadata(["/file"]);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const command = commands[0]!;
    if (kind === "EPIPE") command.stdin!.emit("error", failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Successful stdout cannot hide an earlier failure to transmit the request.
    expect(command.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    reply(command, [metadata()]);
    await expect(pending).rejects.toMatchObject({ code: "helper-failed" });
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it("retains an input failure when killing the child also throws", async () => {
    const failure = Object.assign(new Error("input failed"), { code: "EPIPE" });
    arrange(() => {}, (command) => {
      command.kill.mockImplementation(() => { throw new Error("kill failed"); });
    });
    const pending = readDarwinCloneFileMetadata(["/file"]);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const command = commands[0]!;
    expect(() => command.stdin!.emit("error", failure)).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    reply(command, [metadata()]);
    await expect(pending).rejects.toMatchObject({ code: "helper-failed", cause: failure });
  });
});

describe("public clone metadata decoding and warnings", () => {
  it("preserves exact uint64 identifiers through the public portable parser", async () => {
    portableApi();
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    arrange((command) => reply(command, [metadata(), null]));
    await expect(readCloneFileMetadata(["/exact", "/absent"])).resolves.toEqual([{
      dev: 0xfedcba98, type: 1, mtimeSec: -1234, mtimeNs: 987654321,
      ctimeSec: 123456, ctimeNs: 123456789, uid: 501, gid: 20, mode: 0o100600,
      ino: (1n << 63n) + 7n, size: (1n << 53n) + 9n, cloneId: (1n << 64n) - 1n,
    }, undefined]);
  });

  it("keeps the public parser's unavailable-attribute result", async () => {
    portableApi();
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    arrange((command) => reply(command, [Buffer.alloc(100)]));
    await expect(readCloneFileMetadata(["/unsupported"])).resolves.toEqual([undefined]);
  });

  it("warns once without caller paths, command input or native loader diagnostics", async () => {
    portableApi();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    arrange((command) => reply(command, [null]));
    await readCloneFileMetadata(["/private-first-secret"]);
    await readCloneFileMetadata(["/private-second-secret"]);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("APFS clone metadata"), {
      code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning",
    });
    const text = JSON.stringify(warning.mock.calls);
    expect(text).not.toContain("private-first-secret");
    expect(text).not.toContain("private-second-secret");
    expect(text).not.toContain("native loader");
    expect(text).not.toContain("osascript");
  });
});

describe.each(["linux", "win32", "freebsd"] as const)("clone metadata with spoofed %s", (platform) => {
  const first = platform === "win32" ? "C:\\metadata\\first" : "/metadata/first";
  const second = platform === "win32" ? "C:\\metadata\\second" : "/metadata/second";
  const paths = Object.freeze([first, second, first]);

  beforeEach(() => {
    spoofPlatform(platform);
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  });

  it.each([
    ["auto", "missing-addon"], ["auto", "missing-method"],
    ["off", "missing-addon"], ["off", "missing-method"],
  ] as const)("returns absent entries in %s with %s without running a command", async (mode, missing) => {
    const loader = vi.fn(() => {
      if (missing === "missing-addon") throw new Error("optional package omitted");
      return { closeOwnedFd() {} } as unknown as NativeBinding;
    });
    __setNativeLoaderForTest(loader);
    configureFsSafeNative({ mode });
    await expect(readCloneFileMetadata([])).resolves.toEqual([]);
    const result = await readCloneFileMetadata(paths);
    expect(result).toEqual([undefined, undefined, undefined]);
    expect(Object.keys(result)).toEqual(["0", "1", "2"]);
    expect(paths).toEqual([first, second, first]);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(process.emitWarning).not.toHaveBeenCalled();
    expect(loader).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
  });

  it.each(["missing-addon", "missing-method"] as const)("retains require errors for %s", async (missing) => {
    __setNativeLoaderForTest(() => {
      if (missing === "missing-addon") throw new Error("optional package omitted");
      return { closeOwnedFd() {} } as unknown as NativeBinding;
    });
    configureFsSafeNative({ mode: "require" });
    await expect(readCloneFileMetadata(paths)).rejects.toMatchObject({ code: "helper-unavailable" });
    await expect(readCloneFileMetadata([])).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each(["auto", "require"] as const)("preserves native operational errors in %s", async (mode) => {
    const failure = Object.assign(new Error("native metadata failure"), { code: "EIO" });
    const read = vi.fn(async () => { throw failure; });
    __setNativeLoaderForTest(() => ({ closeOwnedFd() {}, readCloneFileMetadata: read }) as unknown as NativeBinding);
    configureFsSafeNative({ mode });
    await expect(readCloneFileMetadata(paths)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledExactlyOnceWith(paths);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each(["auto", "off"] as const)("validates every path before fallback or native loading in %s", async (mode) => {
    const loader = vi.fn(() => { throw new Error("optional package omitted"); });
    __setNativeLoaderForTest(loader);
    configureFsSafeNative({ mode });
    const invalid = ["", "relative", `${first}\0suffix`];
    if (platform === "win32") invalid.push("C:relative", "C:\\metadata\\file:stream", "\\\\?\\C:");
    for (const [index, pathname] of invalid.entries()) {
      await expect(readCloneFileMetadata([first, pathname, second])).rejects.toMatchObject({
        code: "invalid-path",
        ...(index >= 3 ? { details: { reason: "windows-path-alias" } } : {}),
      });
    }
    expect(loader).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
