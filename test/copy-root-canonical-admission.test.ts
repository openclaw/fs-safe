import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyRootFileSync, createRootFileCopyBatchSync } from "../src/advanced.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

async function fixture() {
  const directory = await tempRoot("fs-safe-copy-canonical-");
  const sourceRoot = path.join(directory, "source");
  const targetRoot = path.join(directory, "target");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(targetRoot);
  const source = path.join(sourceRoot, "input");
  const target = path.join(targetRoot, "output");
  fs.writeFileSync(source, "captured");
  return { directory, sourceRoot, targetRoot, source, target, options: {
    source: { rootPath: sourceRoot, absolutePath: source },
    destination: { rootPath: targetRoot, absolutePath: target },
  } };
}

describe.skipIf(process.platform === "win32")("canonical POSIX copy admission", () => {
  it("does not use textual canonicalization for the checked source root", async () => {
    const f = await fixture();
    const ordinary = fs.realpathSync;
    const calls: fs.PathLike[] = [];
    const probe = vi.spyOn(fs, "realpathSync").mockImplementation((...args: Parameters<typeof ordinary>) => {
      calls.push(args[0]);
      return Reflect.apply(ordinary, fs, args);
    });
    probe.native = ordinary.native;
    using copied = copyRootFileSync(f.options);
    expect(fs.readFileSync(copied.fd, "utf8")).toBe("captured");
    expect(calls).toEqual([]);
  });

  it.each(["source", "destination"] as const)("rejects a %s root replaced during its initial identity observation", async side => {
    const f = await fixture();
    const root = f.options[side].rootPath;
    const lstat = fs.lstatSync;
    let replaced = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof lstat>) => {
      const result = Reflect.apply(lstat, fs, args);
      if (!replaced && args[0] === root && args[1]?.bigint === true) {
        replaced = true;
        fs.renameSync(root, `${root}.saved`);
        fs.mkdirSync(root);
        if (side === "source") fs.writeFileSync(f.source, "replacement");
      }
      return result;
    });
    expect(() => copyRootFileSync(f.options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(replaced).toBe(true);
    expect(fs.existsSync(f.target)).toBe(false);
  });

  it("rejects a source root changed to a symlink back to the original during lexical admission", async () => {
    const f = await fixture();
    const lstat = fs.lstatSync;
    let swapped = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof lstat>) => {
      const result = Reflect.apply(lstat, fs, args);
      if (!swapped && args[0] === f.source && args[1] === undefined) {
        swapped = true;
        fs.renameSync(f.sourceRoot, `${f.sourceRoot}.saved`);
        fs.symlinkSync(`${f.sourceRoot}.saved`, f.sourceRoot, "dir");
      }
      return result;
    });
    expect(() => copyRootFileSync(f.options)).toThrow();
    expect(swapped).toBe(true);
    expect(fs.existsSync(f.target)).toBe(false);
    expect(fs.readFileSync(f.source, "utf8")).toBe("captured");
  });

  it.each(["source", "hop/../source"])("retains kernel root-alias resolution for %s", async linkTarget => {
    const f = await fixture();
    fs.mkdirSync(path.join(f.directory, "elsewhere", "deep"), { recursive: true });
    fs.mkdirSync(path.join(f.directory, "elsewhere", "source"));
    fs.writeFileSync(path.join(f.directory, "elsewhere", "source", "input"), "native alias target");
    fs.symlinkSync("elsewhere/deep", path.join(f.directory, "hop"), "dir");
    const alias = path.join(f.directory, "alias");
    fs.symlinkSync(linkTarget, alias, "dir");
    using batch = createRootFileCopyBatchSync();
    using copied = batch.copyFile({
      ...f.options,
      source: { rootPath: alias, absolutePath: path.join(alias, "input") },
    });
    const source = linkTarget === "source" ? f.source : path.join(f.directory, "elsewhere", "source", "input");
    expect(fs.readFileSync(copied.fd, "utf8")).toBe(fs.readFileSync(source, "utf8"));
    expect(copied.sourceIdentity).toEqual(expect.objectContaining({ ino: fs.statSync(source, { bigint: true }).ino }));
  });

  it("rejects a root alias retargeted after its fallback root capture", async () => {
    const f = await fixture();
    const alias = path.join(f.directory, "alias");
    const replacement = path.join(f.directory, "replacement");
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, "input"), "replacement");
    fs.symlinkSync(f.sourceRoot, alias, "dir");
    const canonicalize = fs.realpathSync.native;
    let resolutions = 0;
    vi.spyOn(fs.realpathSync, "native").mockImplementation((...args: Parameters<typeof canonicalize>) => {
      const result = Reflect.apply(canonicalize, fs, args);
      // The first observation declines the canonical fast path; the second
      // captures the kernel resolver's root before lexical admission.
      if (args[0] === alias && ++resolutions === 2) {
        fs.unlinkSync(alias);
        fs.symlinkSync(replacement, alias, "dir");
      }
      return result;
    });
    expect(() => copyRootFileSync({
      ...f.options,
      source: { rootPath: alias, absolutePath: path.join(alias, "input") },
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(resolutions).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(f.target)).toBe(false);
    expect(fs.readFileSync(path.join(replacement, "input"), "utf8")).toBe("replacement");
  });
});
