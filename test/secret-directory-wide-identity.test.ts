import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { openPrivateStoreLockRoot } from "../src/file-store-boundary.js";
import { configureFsSafeNative } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { createSecretFileAtomic, prepareSecretFileWrite, writeSecretFileAtomic } from "../src/secret-file.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

async function fixture() {
  const rootDir = await tempRoot("fs-safe-secret-wide-identity-");
  const parent = path.join(rootDir, "parent");
  await fs.mkdir(parent, { mode: 0o700 });
  const identities = new Map([
    [rootDir, (1n << 56n) + 1n],
    [parent, (1n << 56n) + 3n],
  ]);
  const directories = new Map<string, string>();
  for (const directory of identities.keys()) {
    const stat = await fs.lstat(directory, { bigint: true });
    directories.set(`${stat.dev}:${stat.ino}`, directory);
  }
  const project = <T extends Stats | BigIntStats>(stat: T, directory: string): T => {
    const ino = identities.get(directory);
    return ino === undefined ? stat : Object.assign(Object.create(stat), {
      ino: typeof stat.ino === "bigint" ? ino : Number(ino),
    });
  };
  for (const method of ["lstat", "stat"] as const) {
    const original = fs[method].bind(fs);
    vi.spyOn(fs, method).mockImplementation((async (...args: Parameters<typeof fs.stat>) =>
      project(await original(...args), String(args[0]))) as typeof fs.stat);
  }
  const lstatSync = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) =>
    project(lstatSync(...args), String(args[0]))) as typeof fsSync.lstatSync);
  const fstat = fsSync.fstatSync.bind(fsSync);
  vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) => {
    const exact = fstat(args[0], { bigint: true });
    return project(fstat(...args), directories.get(`${exact.dev}:${exact.ino}`) ?? "");
  }) as typeof fsSync.fstatSync);
  return { rootDir, parent, identities, filePath: path.join(parent, "state.json") };
}

describe("lossless secret directory identities", () => {
  it("admits a stable identity without comparing it to rounded numeric stats", async () => {
    const { rootDir, parent, filePath, identities } = await fixture();
    const prepared = await prepareSecretFileWrite({ rootDir, filePath });
    expect(prepared.rootGuard.stat.ino).toBe(identities.get(rootDir));
    expect(prepared.parentGuard.stat.ino).toBe(identities.get(parent));
  });

  it("keeps default directory guards numeric", async () => {
    const { rootDir } = await fixture();
    const guard = await createAsyncDirectoryGuard(rootDir);
    expect(typeof guard.stat.ino).toBe("number");
    expect(typeof guard.stat.mode).toBe("number");
  });

  it("binds private lock roots losslessly and rejects a different identity with the same numeric projection", async () => {
    const { rootDir, parent, filePath, identities } = await fixture();
    const lockRoot = await openPrivateStoreLockRoot({ rootDir, filePath });
    await expect(lockRoot.stat("")).resolves.toMatchObject({ isDirectory: true });
    const original = identities.get(parent)!;
    const replacement = original + 2n;
    expect(Number(replacement)).toBe(Number(original));
    identities.set(parent, replacement);
    await expect(lockRoot.stat("")).rejects.toMatchObject({ code: "path-mismatch" });
  });
});

for (const route of ["fallback", "Windows fallback", "native", "Windows native"] as const) {
  describe.skipIf((route.includes("native") && !nativeAvailable) || (route === "native" && process.platform === "win32"))(
    `lossless secret directories through ${route}`,
    () => {
      function configureRoute() {
        if (route.includes("native")) {
          const binding = __loadBundledNativeForTest();
          __setNativeLoaderForTest(() => binding);
        }
        if (route.startsWith("Windows")) Object.defineProperty(process, "platform", { value: "win32" });
        configureFsSafeNative({ mode: route.includes("native") ? "require" : "off" });
      }

      it.each([
        { operation: "write", write: writeSecretFileAtomic },
        { operation: "create", write: createSecretFileAtomic },
      ])("$operation writes real bytes through exact directory guards", async ({ write }) => {
        const { rootDir, filePath } = await fixture();
        configureRoute();
        await write({ rootDir, filePath, content: "synthetic wide-directory proof" });
        expect(await fs.readFile(filePath, "utf8")).toBe("synthetic wide-directory proof");
      });

      it("rejects an exact root mismatch before creating a file", async () => {
        const { rootDir, parent, filePath, identities } = await fixture();
        const { parentGuard } = await prepareSecretFileWrite({ rootDir, filePath });
        configureRoute();
        const original = identities.get(parent)!;
        expect(Number(original + 2n)).toBe(Number(original));
        identities.set(parent, original + 2n);
        await expect(runPinnedWriteHelper({
          rootPath: parent, relativeParentPath: "", basename: "state.json", mkdir: false,
          mode: 0o600, input: { kind: "buffer", data: "must not be published" },
          rootIdentity: { dev: parentGuard.stat.dev, ino: parentGuard.stat.ino },
        })).rejects.toMatchObject({ code: "path-mismatch" });
        expect(await fs.readdir(parent)).toEqual([]);
      });
    },
  );
}
