import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix } from "./helpers/vitest.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { configureFsSafeNative, root as openRoot } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, getNativeBinding } from "../src/native.js";
import { ESCAPING_DIRECTORY_PAYLOADS, ESCAPING_WRITE_PAYLOADS, expectFsSafeCode, expectNoOutsideWrite, LITERAL_SUSPICIOUS_DIRECTORY_PAYLOADS, LITERAL_SUSPICIOUS_WRITE_PAYLOADS, makeTempLayout as makeSecurityTempLayout, POSIX_LITERAL_SUSPICIOUS_WRITE_PAYLOADS, SAFE_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS, WINDOWS_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS, expectFsSafeError } from "./helpers/security.js";

let bundledNativeAvailable = false;
try {
  __loadBundledNativeForTest();
  bundledNativeAvailable = true;
} catch {
  // JavaScript-only test runs intentionally have no host binding.
}

const tempDirs: string[] = [];

async function makeTempLayout(prefix: string) {
  return await makeSecurityTempLayout(prefix, tempDirs);
}

afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { force: true, recursive: true })));
});

describe("write, move, and delete boundary bypass attempts", () => {
  it("rejects payload corpus write/create/append/openWritable attempts without touching outside files", async () => {
    const layout = await makeTempLayout("fs-safe-write-payloads");
    await fsp.mkdir(path.join(layout.root, "nested"), { recursive: true });
    const safeRoot = await openRoot(layout.root);

    for (const payload of ESCAPING_WRITE_PAYLOADS) {
      await expect(safeRoot.write(payload, "pwned"), `write(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.create(payload, "pwned"), `create(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.append(payload, "pwned"), `append(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.openWritable(payload), `openWritable(${payload})`).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  it("rejects payload corpus mkdir and remove attempts", async () => {
    const layout = await makeTempLayout("fs-safe-dir-payloads");
    await fsp.mkdir(path.join(layout.root, "nested"), { recursive: true });
    const safeRoot = await openRoot(layout.root);

    for (const payload of ESCAPING_DIRECTORY_PAYLOADS) {
      await expect(safeRoot.mkdir(payload), `mkdir(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.remove(payload), `remove(${payload})`).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  it("rejects absolute outside write/create/append/openWritable/copy destinations", async () => {
    const layout = await makeTempLayout("fs-safe-write-absolute");
    const safeRoot = await openRoot(layout.root);
    const source = path.join(layout.root, "source.txt");
    await fsp.writeFile(source, "source");

    await expect(safeRoot.write(layout.outsideFile, "pwned")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["outside-workspace", "path-alias", "invalid-path"]);
      return true;
    });
    await expect(safeRoot.create(layout.outsideFile, "pwned")).rejects.toBeTruthy();
    await expect(safeRoot.append(layout.outsideFile, "pwned")).rejects.toBeTruthy();
    await expect(safeRoot.openWritable(layout.outsideFile)).rejects.toBeTruthy();
    await expect(safeRoot.copyIn(layout.outsideFile, source)).rejects.toBeTruthy();
    await expectNoOutsideWrite(layout);
  });

  it("rejects symlink parent write/create/append/openWritable/copy/mkdir/remove destinations", async () => {
    const layout = await makeTempLayout("fs-safe-write-symlink-parent");
    await fsp.symlink(layout.outside, path.join(layout.root, "link"), "dir");
    const safeRoot = await openRoot(layout.root);
    const source = path.join(layout.root, "source.txt");
    await fsp.writeFile(source, "source");

    for (const action of [
      () => safeRoot.write("link/secret.txt", "pwned"),
      () => safeRoot.create("link/secret.txt", "pwned"),
      () => safeRoot.append("link/secret.txt", "pwned"),
      () => safeRoot.openWritable("link/secret.txt"),
      () => safeRoot.copyIn("link/secret.txt", source),
      () => safeRoot.mkdir("link/nested"),
      () => safeRoot.remove("link/secret.txt"),
    ]) {
      await expect(action()).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  itPosix("rejects file store symlink parent writes", async () => {
    const layout = await makeTempLayout("fs-safe-file-store-symlink-parent");
    const source = path.join(layout.root, "source.txt");
    await fsp.writeFile(source, "source");
    await fsp.symlink(layout.outside, path.join(layout.root, "link"), "dir");
    const store = fileStore({ rootDir: layout.root });
    const syncStore = fileStoreSync({ rootDir: layout.root });

    await expect(store.write("link/write.txt", "pwned")).rejects.toBeTruthy();
    await expect(store.writeStream("link/stream.txt", Readable.from(["pwned"]))).rejects
      .toBeTruthy();
    await expect(store.copyIn("link/copy.txt", source)).rejects.toBeTruthy();
    expect(() => syncStore.write("link/sync-write.txt", "pwned")).toThrow();
    expect(() => syncStore.writeText("link/sync-text.txt", "pwned")).toThrow();
    expect(() => syncStore.writeJson("link/sync-json.json", { pwned: true })).toThrow();
    await expectNoOutsideWrite(layout);
    await expect(fsp.readdir(layout.outside)).resolves.toEqual(["secret.txt"]);
  });

  it("rejects final symlink leaf write/append/openWritable/copy targets without clobbering their target", async () => {
    const layout = await makeTempLayout("fs-safe-write-symlink-leaf");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "link.txt"), "file");
    const source = path.join(layout.root, "source.txt");
    await fsp.writeFile(source, "source");
    const safeRoot = await openRoot(layout.root);

    for (const action of [
      () => safeRoot.write("link.txt", "pwned"),
      () => safeRoot.append("link.txt", "pwned"),
      () => safeRoot.openWritable("link.txt"),
      () => safeRoot.copyIn("link.txt", source),
    ]) {
      await expect(action()).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
  });

  it("rejects hardlinked write and append targets", async () => {
    const layout = await makeTempLayout("fs-safe-write-hardlink");
    const source = path.join(layout.root, "source.txt");
    const hardlink = path.join(layout.root, "hardlink.txt");
    await fsp.writeFile(source, "shared");
    await fsp.link(source, hardlink);
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.write("hardlink.txt", "pwned")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["hardlink", "invalid-path", "path-alias"]);
      return true;
    });
    await expect(safeRoot.append("hardlink.txt", "pwned")).rejects.toSatisfy((error: unknown) => {
      expectFsSafeCode(error, ["hardlink", "invalid-path", "path-alias"]);
      return true;
    });
  });

  it("rejects move payloads for escaping sources and destinations", async () => {
    const layout = await makeTempLayout("fs-safe-move-payloads");
    await fsp.writeFile(path.join(layout.root, "from.txt"), "from");
    const safeRoot = await openRoot(layout.root);

    for (const payload of ESCAPING_WRITE_PAYLOADS) {
      await expect(safeRoot.move(payload, "to.txt"), `move-from(${payload})`).rejects.toBeTruthy();
      await expect(safeRoot.move("from.txt", payload), `move-to(${payload})`).rejects.toBeTruthy();
    }
    await expectNoOutsideWrite(layout);
    await expect(fsp.readFile(path.join(layout.root, "from.txt"), "utf8")).resolves.toBe("from");
  });

  it("rejects symlink move source and destination endpoints without touching outside targets", async () => {
    const layout = await makeTempLayout("fs-safe-move-symlink");
    await fsp.writeFile(path.join(layout.root, "from.txt"), "from");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "source-link.txt"), "file");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "dest-link.txt"), "file");
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.move("source-link.txt", "moved.txt")).rejects.toBeTruthy();
    if (process.platform === "win32") {
      await expectFsSafeError(safeRoot.move("from.txt", "dest-link.txt", { overwrite: true }), "path-alias");
      await expectNoOutsideWrite(layout);
      return;
    }

    await safeRoot.move("from.txt", "dest-link.txt", { overwrite: true });
    await expectNoOutsideWrite(layout);
    await expect(fsp.readFile(path.join(layout.root, "dest-link.txt"), "utf8")).resolves.toBe("from");
  });

  it("rejects remove through symlink parents but removes final symlink entries without following", async () => {
    const layout = await makeTempLayout("fs-safe-remove-symlink");
    await fsp.symlink(layout.outside, path.join(layout.root, "parent-link"), "dir");
    await fsp.symlink(layout.outsideFile, path.join(layout.root, "leaf-link.txt"), "file");
    const safeRoot = await openRoot(layout.root);

    await expect(safeRoot.remove("parent-link/secret.txt")).rejects.toBeTruthy();
    await safeRoot.remove("leaf-link.txt");
    await expect(fsp.lstat(path.join(layout.root, "leaf-link.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoOutsideWrite(layout);
  });

  // This test exercises many fs writes/reads/mkdirs; bump the timeout for
  // slow windows fs under parallel test load (default 5s is sometimes tight).
  it("keeps encoded, backslash, Windows, and UNC-looking write payloads literal and inside root", async () => {
    const layout = await makeTempLayout("fs-safe-write-encoded-literal");
    const safeRoot = await openRoot(layout.root);

    const literalWritePayloads = process.platform === "win32"
      ? LITERAL_SUSPICIOUS_WRITE_PAYLOADS
      : [...LITERAL_SUSPICIOUS_WRITE_PAYLOADS, ...POSIX_LITERAL_SUSPICIOUS_WRITE_PAYLOADS];
    for (const payload of literalWritePayloads) {
      await safeRoot.write(payload, "literal");
      await expect(safeRoot.readText(payload), `read literal ${payload}`).resolves.toBe("literal");
    }
    if (process.platform === "win32") {
      for (const payload of POSIX_LITERAL_SUSPICIOUS_WRITE_PAYLOADS) {
        await expect(safeRoot.write(payload, "rejected"), `write safely rejects ${payload}`).rejects.toBeTruthy();
      }
    }
    for (const payload of SAFE_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS) {
      await expect(safeRoot.mkdir(payload), `mkdir safely rejects ${payload}`).rejects.toBeTruthy();
    }
    if (process.platform === "win32") {
      for (const payload of WINDOWS_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS) {
        await expect(safeRoot.mkdir(payload), `mkdir safely rejects ${payload}`).rejects.toBeTruthy();
      }
    } else {
      for (const payload of WINDOWS_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS) {
        await safeRoot.mkdir(payload);
        await expect(fsp.stat(path.join(layout.root, payload)), `created literal ${payload}`).resolves.toSatisfy((stat) =>
          stat.isDirectory()
        );
      }
    }
    for (const payload of LITERAL_SUSPICIOUS_DIRECTORY_PAYLOADS) {
      await safeRoot.mkdir(payload);
      if (process.platform === "win32") {
        // safeRoot.list uses the pinned helper which is unavailable on
        // windows; verify the directory exists via fsp.stat instead.
        await expect(fsp.stat(path.join(layout.root, payload)), `created literal ${payload}`)
          .resolves.toSatisfy((stat) => stat.isDirectory());
      } else {
        await expect(safeRoot.list(payload), `list literal ${payload}`).resolves.toBeInstanceOf(Array);
      }
    }
    await expectNoOutsideWrite(layout);
  }, 15000);

  itPosix("keeps literal '..'-prefixed read paths available when the helper is disabled", async () => {
    configureFsSafeNative({ mode: "off" });
    const layout = await makeTempLayout("fs-safe-write-helper-off-literal");
    const safeRoot = await openRoot(layout.root);
    await fsp.writeFile(path.join(layout.root, "..%2fpwned.txt"), "literal");

    await expect(safeRoot.write("..%2fpwned-2.txt", "literal")).resolves.toBeUndefined();
    await expect(fsp.readFile(path.join(layout.root, "..%2fpwned-2.txt"), "utf8")).resolves.toBe(
      "literal",
    );
    await expect(safeRoot.stat("..%2fpwned.txt")).resolves.toMatchObject({ isFile: true });
    await safeRoot.remove("..%2fpwned.txt");
    await expect(fsp.stat(path.join(layout.root, "..%2fpwned.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectNoOutsideWrite(layout);
  });

  describe.each(["missing", "existing"] as const)("parent swap with %s outside destination", (destination) => {
    itPosix.each([
      { operation: "append", mode: "off" },
      { operation: "append", mode: "auto" },
      { operation: "openWritable", mode: "off" },
      { operation: "openWritable", mode: "auto" },
      { operation: "copyIn", mode: "off" },
    ] as const)("$operation ($mode) rejects after the bounded mkdir side effect", async ({ operation, mode }) => {
      configureFsSafeNative({ mode });
      // Load the real host binding in auto mode when available; parent preparation stays in JS.
      expect(Boolean(getNativeBinding())).toBe(mode === "auto" && bundledNativeAvailable);
      const layout = await makeTempLayout("fs-safe-write-mkdir-swap");
      const safeRoot = await openRoot(layout.root);
      const parent = path.join(safeRoot.rootReal, "data");
      const originalParent = path.join(safeRoot.rootReal, "data-original");
      const swapTarget = path.join(parent, "logs");
      const source = path.join(layout.root, "source.txt");
      const outsideLogs = path.join(layout.outside, "logs");
      const outsideTarget = path.join(outsideLogs, "nested", "app.log");
      const originalBytes = Buffer.from("existing outside target\n");
      await fsp.mkdir(parent);
      await fsp.writeFile(source, "payload");
      if (destination === "existing") {
        await fsp.mkdir(path.dirname(outsideTarget), { recursive: true });
        await fsp.writeFile(outsideTarget, originalBytes);
      }

      const realMkdir = fsp.mkdir.bind(fsp);
      let swapCount = 0;
      vi.spyOn(fsp, "mkdir").mockImplementation(async (candidate, options) => {
        // Swap after the parent guard, immediately before the real pathname syscall.
        if (String(candidate) === swapTarget && ++swapCount === 1) {
          await fsp.rename(parent, originalParent);
          await fsp.symlink(layout.outside, parent, "dir");
        }
        return await realMkdir(candidate, options);
      });

      const run = async () => {
        const target = "data/logs/nested/app.log";
        if (operation === "append") {
          return await safeRoot.append(target, "payload");
        }
        if (operation === "copyIn") {
          return await safeRoot.copyIn(target, source);
        }
        const opened = await safeRoot.openWritable(target);
        await opened.handle.close();
      };
      await expect(run()).rejects.toSatisfy((error: unknown) => {
        expectFsSafeCode(error, ["outside-workspace"]);
        expect(error).toHaveProperty("message", "directory escaped workspace root");
        return true;
      });
      expect(swapCount).toBe(1);

      const logsStat = await fsp.lstat(outsideLogs);
      expect(logsStat.isDirectory()).toBe(true);
      expect(logsStat.isSymbolicLink()).toBe(false);
      const expectedOutside = destination === "existing"
        ? ["logs", "logs/nested", "logs/nested/app.log", "secret.txt"]
        : ["logs", "secret.txt"];
      expect((await fsp.readdir(layout.outside, { recursive: true })).sort()).toEqual(expectedOutside);
      if (destination === "existing") {
        await expect(fsp.readFile(outsideTarget)).resolves.toEqual(originalBytes);
      } else {
        await expect(fsp.readdir(outsideLogs)).resolves.toEqual([]);
      }
      await expect(fsp.readdir(originalParent)).resolves.toEqual([]);
      await expectNoOutsideWrite(layout);
    });
  });
});
