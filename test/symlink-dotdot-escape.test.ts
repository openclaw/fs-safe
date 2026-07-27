import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, FsSafeError, root, type Root } from "../src/index.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../src/native.js";
import { resolveRootPath, resolveRootPathSync } from "../src/root-path.js";

type NativeBinding = typeof import("../native/index.js");

const require = createRequire(import.meta.url);
let native: NativeBinding | undefined;
try {
  native = require("../native") as NativeBinding;
} catch {
  // Ordinary JavaScript-only jobs intentionally run without a platform artifact.
}

const tempDirs: string[] = [];
const fixtureParent = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
const escapePath = "sub/up/../outside/secret.txt";

afterEach(async () => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function makeStaticEscapeFixture(): Promise<{
  rootDir: string;
  outsideFile: string;
}> {
  const base = await mkdtemp(path.join(fixtureParent, "fs-safe-symlink-dotdot-"));
  tempDirs.push(base);
  const rootDir = path.join(base, "root");
  const outsideDir = path.join(base, "outside");
  const outsideFile = path.join(outsideDir, "secret.txt");

  await mkdir(path.join(rootDir, "sub"), { recursive: true });
  await mkdir(outsideDir);
  await symlink("..", path.join(rootDir, "sub", "up"), "dir");
  await writeFile(outsideFile, "outside-secret");
  return { rootDir, outsideFile };
}

async function expectBlocked(action: () => Promise<unknown>): Promise<void> {
  let value: unknown;
  try {
    value = await action();
  } catch (error) {
    expect(error).toBeInstanceOf(FsSafeError);
    return;
  }

  if (typeof value === "object" && value !== null && "handle" in value) {
    await (value as { handle: { close(): Promise<void> } }).handle.close();
  }
  expect.unreachable("static symlink + .. escape was accepted");
}

describe("static symlink + dot-dot boundary escape", () => {
  const operations: Array<{
    name: string;
    run(scoped: Root): Promise<unknown>;
  }> = [
    { name: "read", run: (scoped) => scoped.read(escapePath) },
    { name: "write", run: (scoped) => scoped.write(escapePath, "write-escaped") },
    { name: "open", run: (scoped) => scoped.open(escapePath) },
    { name: "openWritable", run: (scoped) => scoped.openWritable(escapePath) },
  ];

  const backends = native ? (["javascript", "native"] as const) : (["javascript"] as const);

  describe.each(backends)("%s path", (backend) => {
    it.runIf(process.platform !== "win32").each(operations)(
      "blocks $name",
      async ({ run }) => {
        if (backend === "native") {
          __setNativeLoaderForTest(() => native!);
          configureFsSafeNative({ mode: "require" });
        } else {
          __setNativeLoaderForTest(() => {
            throw Object.assign(new Error("native helper disabled for regression proof"), {
              code: "MODULE_NOT_FOUND",
            });
          });
          configureFsSafeNative({ mode: "auto" });
        }

        const fixture = await makeStaticEscapeFixture();
        const scoped = await root(fixture.rootDir);

        await expectBlocked(() => run(scoped));
        await expect(readFile(fixture.outsideFile, "utf8")).resolves.toBe("outside-secret");
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "reports best-effort containment for JavaScript root results",
    async () => {
      __setNativeLoaderForTest(() => {
        throw Object.assign(new Error("native helper disabled for fallback proof"), {
          code: "MODULE_NOT_FOUND",
        });
      });
      configureFsSafeNative({ mode: "auto" });
      const base = await mkdtemp(path.join(fixtureParent, "fs-safe-containment-result-"));
      tempDirs.push(base);
      await writeFile(path.join(base, "input.txt"), "input");
      const scoped = await root(base);

      const opened = await scoped.open("input.txt");
      expect(opened.containment).toBe("best-effort");
      await opened.handle.close();
      await expect(scoped.read("input.txt")).resolves.toMatchObject({
        containment: "best-effort",
      });
      const writable = await scoped.openWritable("output.txt");
      expect(writable.containment).toBe("best-effort");
      await writable.handle.close();
    },
  );

  it.runIf(process.platform !== "win32")(
    "walks aliases before dot-dot in async and sync root-path resolution",
    async () => {
      const fixture = await makeStaticEscapeFixture();
      const absolutePath = `${fixture.rootDir}/${escapePath}`;
      const params = {
        rootPath: fixture.rootDir,
        rootCanonicalPath: fixture.rootDir,
        absolutePath,
        boundaryLabel: "root",
      } as const;

      await expect(resolveRootPath(params)).rejects.toThrow("outside root");
      expect(() => resolveRootPathSync(params)).toThrow("outside root");
    },
  );
});
