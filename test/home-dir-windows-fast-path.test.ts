import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHomeRelativePath } from "../src/home-dir.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

function setPlatform(value: NodeJS.Platform | undefined): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value,
  });
}

function resolveToInput(): void {
  vi.spyOn(path, "resolve").mockImplementation((...segments) => segments.at(-1)!);
}

function captureThrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("expected call to throw");
}

describe("Windows home-path admission fast path", () => {
  it.each([
    "C:\\safe\\nested\\file.txt",
    "z:\\safe\\nested\\file.txt",
    "D:/safe/nested/file.txt",
  ])("preserves an unchanged ordinary rooted drive path: %s", (input) => {
    setPlatform("win32");
    resolveToInput();
    const opts = Object.defineProperties({}, {
      env: { get: () => { throw new Error("must not read env"); } },
      homedir: { get: () => { throw new Error("must not read homedir"); } },
    });

    expect(resolveHomeRelativePath(input, opts)).toBe(input);
    expect(path.resolve).toHaveBeenCalledOnce();
    expect(path.resolve).toHaveBeenCalledWith(input);
  });

  it("fully admits a changed resolver result", () => {
    setPlatform("win32");
    vi.spyOn(path, "resolve").mockReturnValue("C:\\safe\\file.txt:stream");

    expect(() => resolveHomeRelativePath("C:/safe/file.txt")).toThrow(
      expect.objectContaining({
        code: "invalid-path",
        details: { reason: "windows-path-alias" },
      }),
    );
  });

  it.each([
    "C:\\safe\\file.txt:stream\\..",
    "C:\\safe\\dir::$INDEX_ALLOCATION\\..",
    "Z:relative.txt",
    "1:\\safe\\file.txt",
    "é:\\safe\\file.txt",
    "\\\\?\\C:",
    "\\\\.\\C:",
  ])("rejects a raw alias before resolution: %s", (input) => {
    setPlatform("win32");
    const resolve = vi.spyOn(path, "resolve");
    const opts = Object.defineProperties({}, {
      env: { get: () => { throw new Error("must not read env"); } },
      homedir: { get: () => { throw new Error("must not read homedir"); } },
    });

    expect(() => resolveHomeRelativePath(input, opts)).toThrow(
      expect.objectContaining({
        code: "invalid-path",
        details: { reason: "windows-path-alias" },
      }),
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not fast-admit boxed strings", () => {
    setPlatform("win32");
    const boxed = new String("C:\\safe\\nested\\file.txt");

    expect(() => resolveHomeRelativePath(boxed as unknown as string)).toThrow(TypeError);
  });

  it("preserves platform reads when the resolved-path read is undefined", () => {
    const platforms = ["win32", undefined, "win32"] as const;
    let reads = 0;
    Object.defineProperty(process, "platform", {
      configurable: true,
      get: () => platforms[reads++],
    });
    resolveToInput();

    expect(resolveHomeRelativePath("C:\\safe\\nested\\file.txt"))
      .toBe("C:\\safe\\nested\\file.txt");
    expect(reads).toBe(3);
  });

  it("rechecks an undefined raw platform before resolving an alias", () => {
    const platforms = [undefined, "win32"] as const;
    let reads = 0;
    Object.defineProperty(process, "platform", {
      configurable: true,
      get: () => platforms[reads++],
    });
    const resolve = vi.spyOn(path, "resolve");
    const opts = Object.defineProperties({}, {
      env: { get: () => { throw new Error("must not read env"); } },
      homedir: { get: () => { throw new Error("must not read homedir"); } },
    });

    expect(() => resolveHomeRelativePath("C:\\safe\\file.txt:stream", opts)).toThrow(
      expect.objectContaining({ code: "invalid-path" }),
    );
    expect(reads).toBe(2);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("propagates the classifier platform read after an undefined resolved read", () => {
    const failure = new Error("platform getter failed");
    let reads = 0;
    Object.defineProperty(process, "platform", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads === 1) return "win32";
        if (reads === 2) return undefined;
        throw failure;
      },
    });
    resolveToInput();

    expect(captureThrown(() => resolveHomeRelativePath("C:\\safe\\nested\\file.txt")))
      .toBe(failure);
    expect(reads).toBe(3);
  });

  it("checks a raw non-Windows alias again when resolution switches to Windows", () => {
    const platforms = ["linux", "win32"] as const;
    let reads = 0;
    Object.defineProperty(process, "platform", {
      configurable: true,
      get: () => platforms[reads++],
    });
    vi.spyOn(path, "resolve").mockReturnValue("C:\\safe\\file.txt:stream");

    expect(() => resolveHomeRelativePath("relative:literal.txt")).toThrow(
      expect.objectContaining({ code: "invalid-path" }),
    );
    expect(reads).toBe(2);
  });

  it("preserves root-resolver platform reads for seven-character input", () => {
    let reads = 0;
    Object.defineProperty(process, "platform", {
      configurable: true,
      get: () => {
        reads += 1;
        return "win32";
      },
    });
    resolveToInput();

    expect(resolveHomeRelativePath("C:\\safe")).toBe("C:\\safe");
    expect(reads).toBe(3);
  });

  it("preserves root repair and its platform reads for a six-character result", () => {
    let reads = 0;
    Object.defineProperty(process, "platform", {
      configurable: true,
      get: () => {
        reads += 1;
        return "win32";
      },
    });
    vi.spyOn(path, "resolve").mockReturnValue("\\\\?\\C:");

    expect(resolveHomeRelativePath("C:\\safe\\nested\\file.txt")).toBe("\\\\?\\C:\\");
    expect(reads).toBe(4);
  });

  it("keeps valid namespace roots on the full admission path", () => {
    setPlatform("win32");
    resolveToInput();

    expect(resolveHomeRelativePath("\\\\?\\C:\\safe\\file.txt"))
      .toBe("\\\\?\\C:\\safe\\file.txt");
  });

  it("keeps non-string admission ahead of prefix and resolver access", () => {
    setPlatform("win32");
    const failure = new Error("indexOf failed");
    const input = {
      indexOf: () => { throw failure; },
      get startsWith() { throw new Error("must not inspect the prefix"); },
    };
    const resolve = vi.spyOn(path, "resolve");

    expect(captureThrown(() => resolveHomeRelativePath(input as unknown as string)))
      .toBe(failure);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns empty input before platform or option access", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      get: () => { throw new Error("must not read platform"); },
    });
    const opts = Object.defineProperties({}, {
      env: { get: () => { throw new Error("must not read env"); } },
      homedir: { get: () => { throw new Error("must not read homedir"); } },
    });

    expect(resolveHomeRelativePath("", opts)).toBe("");
  });
});
