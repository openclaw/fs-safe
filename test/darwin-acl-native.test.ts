import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectDarwinAcl } from "../src/darwin-acl.js";
import type { NativeBinding } from "../src/native-binding.js";
import {
  configureFsSafeNative,
  getFsSafeNativeConfig,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { useTempDirs } from "./helpers/vitest.js";

let binding: NativeBinding | undefined;
if (process.platform === "darwin") {
  const required = getFsSafeNativeConfig().mode === "require";
  try {
    binding = __loadBundledNativeForTest();
  } catch (cause) {
    // The fallback lane intentionally has no native package.
    if (required) {
      throw new Error("Darwin ACL native tests require a loadable bundled native helper", { cause });
    }
  }
  if (required && typeof binding?.inspectDarwinAcl !== "function") {
    throw new Error("Required Darwin native helper is missing inspectDarwinAcl");
  }
}
const { tempRoot } = useTempDirs();

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.runIf(binding !== undefined)("Darwin native descriptor ACL inspection", () => {
  it("exports the capability and preserves the caller's descriptor and file position", async () => {
    configureFsSafeNative({ mode: "require" });
    expect(typeof binding!.inspectDarwinAcl).toBe("function");
    const target = path.join(await tempRoot("fs-safe-darwin-acl-fd-"), "file");
    fs.writeFileSync(target, "abcdef", { mode: 0o600 });
    const fd = fs.openSync(target, "r");
    try {
      const bytes = Buffer.alloc(2);
      fs.readSync(fd, bytes);
      expect(bytes.toString()).toBe("ab");
      expect(["absent", "empty", "present"]).toContain(inspectDarwinAcl(fd).state);
      fs.readSync(fd, bytes);
      expect(bytes.toString()).toBe("cd");
      expect(fs.fstatSync(fd).isFile()).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("fails on an invalid fd without affecting a live caller descriptor", async () => {
    expect(typeof binding!.inspectDarwinAcl).toBe("function");
    const target = path.join(await tempRoot("fs-safe-darwin-acl-error-"), "file");
    fs.writeFileSync(target, "fixture", { mode: 0o600 });
    const fd = fs.openSync(target, "r");
    try {
      expect(() => binding!.inspectDarwinAcl!(-1)).toThrowError(expect.objectContaining({ code: "EBADF" }));
      expect(fs.fstatSync(fd).isFile()).toBe(true);
      expect(["absent", "empty", "present"]).toContain(binding!.inspectDarwinAcl!(fd).state);
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe.runIf(binding !== undefined)("Darwin clone fallback boundary", () => {
  const securityFailures = [
    "clear cloned file ACL",
    "re-admit clone parent",
    "re-admit private clone stage",
    "cloned payload publication",
    "cloned payload handoff",
  ].flatMap(operation =>
    ["ENOTSUP", "EINVAL", "EPERM"].flatMap(code =>
      [false, true].map(cleanupFailed => ({ operation, code, cleanupFailed })),
    ),
  );
  it.each(securityFailures)(
    "does not retry $operation ($code, cleanup failed: $cleanupFailed)",
    async ({ operation, code, cleanupFailed }) => {
      configureFsSafeNative({ mode: "require" });
      const directory = await tempRoot("fs-safe-darwin-clone-terminal-");
      const sourcePath = path.join(directory, "source");
      const targetPath = path.join(directory, "target");
      fs.writeFileSync(sourcePath, "fixture contents", { mode: 0o600 });
      // Model the native error after its checked cleanup. Rust regressions cover
      // conversion from the underlying ACL errno before it reaches either caller.
      const failure = Object.assign(new Error(
        `cloned payload security failure (${code}): ${operation}` +
        (cleanupFailed ? "; cleanup failed: cleanup unsupported" : ""),
      ), { code: "EIO" });
      const clone = vi.fn(() => { throw failure; });
      const copyRange = vi.fn(async () => ({ fd: -1, bytes: 0, errorCode: "ENOTSUP" }));
      __setNativeLoaderForTest(() => ({
        ...binding!,
        linkBeneath() {
          throw Object.assign(new Error("force clone"), { code: "EXDEV" });
        },
        cloneFileExclusive: clone,
        copyFileRangeExclusive: copyRange,
      }));

      await expect(
        publishFileExclusive({ sourcePath, targetPath, strategy: "link-or-copy" }),
      ).rejects.toBe(failure);
      expect(clone).toHaveBeenCalledOnce();
      expect(copyRange).not.toHaveBeenCalled();
      expect(fs.readdirSync(directory)).toEqual(["source"]);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe("fixture contents");
    },
  );

  it("retains ordinary-copy fallback for pre-creation unsupported admission", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-darwin-clone-admission-fallback-");
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    fs.writeFileSync(sourcePath, "fixture contents", { mode: 0o600 });
    const clone = vi.fn(() => {
      expect(fs.existsSync(targetPath)).toBe(false);
      throw Object.assign(new Error("clone directory admission unsupported"), { code: "ENOTSUP" });
    });
    const copyRange = vi.fn(async () => ({ fd: -1, bytes: 0, errorCode: "ENOTSUP" }));
    __setNativeLoaderForTest(() => ({
      ...binding!,
      linkBeneath() {
        throw Object.assign(new Error("force clone"), { code: "EXDEV" });
      },
      cloneFileExclusive: clone,
      copyFileRangeExclusive: copyRange,
    }));

    await expect(
      publishFileExclusive({ sourcePath, targetPath, strategy: "link-or-copy" }),
    ).resolves.toMatchObject({ method: "exclusive-copy" });
    expect(clone).toHaveBeenCalledOnce();
    expect(copyRange).toHaveBeenCalledOnce();
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("fixture contents");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("fixture contents");
  });
});
