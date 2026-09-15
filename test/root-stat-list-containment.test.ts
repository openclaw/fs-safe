import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  __setFsSafeTestHooksForTest();
});

async function replaceDirectoryWithAlias(directory: string, replacement: string): Promise<void> {
  await fs.rename(directory, `${directory}-original`);
  await fs.symlink(replacement, directory, process.platform === "win32" ? "junction" : "dir");
}

it("rejects stat metadata when a selected parent is redirected before observation", async () => {
  const container = await tempRoot("fs-safe-stat-parent-containment-");
  const rootDir = path.join(container, "root");
  const selected = path.join(rootDir, "selected");
  const outside = path.join(container, "outside");
  await fs.mkdir(selected, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(selected, "value"), "inside");
  await fs.writeFile(path.join(outside, "value"), "outside metadata must not be returned");
  const capability = await root(rootDir);
  let intercepted = false;
  __setFsSafeTestHooksForTest({
    async beforeRootStatObservation(targetPath) {
      expect(targetPath).toBe(path.join(selected, "value"));
      intercepted = true;
      await replaceDirectoryWithAlias(selected, outside);
    },
  });

  await expect(capability.stat("selected/value")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(intercepted).toBe(true);
  await expect(fs.readFile(path.join(outside, "value"), "utf8"))
    .resolves.toBe("outside metadata must not be returned");
});

it("rejects stat metadata when the exact selected target becomes an outside alias", async () => {
  const container = await tempRoot("fs-safe-stat-target-containment-");
  const rootDir = path.join(container, "root");
  const selected = path.join(rootDir, "selected");
  const target = path.join(selected, "target");
  const outside = path.join(container, "outside");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret"), "outside");
  const capability = await root(rootDir);
  __setFsSafeTestHooksForTest({
    async beforeRootStatObservation(targetPath) {
      expect(targetPath).toBe(target);
      await replaceDirectoryWithAlias(target, outside);
    },
  });

  await expect(capability.stat("selected/target")).rejects.toMatchObject({ code: "path-mismatch" });
});

it("checks the admitted parent before exposing an initial not-found observation", async () => {
  const container = await tempRoot("fs-safe-stat-initial-error-containment-");
  const rootDir = path.join(container, "root");
  const selected = path.join(rootDir, "selected");
  const original = `${selected}-original`;
  const outside = path.join(container, "outside");
  await fs.mkdir(selected, { recursive: true });
  await fs.mkdir(outside);
  const capability = await root(rootDir);
  __setFsSafeTestHooksForTest({
    async beforeRootStatInitialObservation(targetPath) {
      expect(targetPath).toBe(path.join(selected, "missing"));
      await replaceDirectoryWithAlias(selected, outside);
    },
  });

  try {
    await expect(capability.stat("selected/missing")).rejects.toMatchObject({ code: "path-mismatch" });
  } finally {
    __setFsSafeTestHooksForTest();
    await fs.unlink(selected);
    await fs.rename(original, selected);
  }
  await expect(capability.stat("selected/missing")).rejects.toMatchObject({ code: "not-found" });
  await expect(capability.exists("selected/missing")).resolves.toBe(false);
});

it.each([false, true])(
  "preserves not-found when list selects an existing regular file (withFileTypes=%s)",
  async (withFileTypes) => {
    const rootDir = await tempRoot("fs-safe-list-file-compatibility-");
    await fs.writeFile(path.join(rootDir, "value"), "not a directory");
    const capability = await root(rootDir);

    const listing = withFileTypes
      ? capability.list("value", { withFileTypes: true })
      : capability.list("value");
    await expect(listing).rejects.toMatchObject({ code: "not-found" });
  },
);

it.each([false, true])(
  "rejects a redirected selected directory before returning list metadata (withFileTypes=%s)",
  async (withFileTypes) => {
    const container = await tempRoot("fs-safe-list-containment-");
    const rootDir = path.join(container, "root");
    const selected = path.join(rootDir, "selected");
    const outside = path.join(container, "outside");
    await fs.mkdir(selected, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(selected, "inside"), "inside");
    await fs.writeFile(path.join(outside, "outside-secret"), "outside metadata must not be returned");
    const capability = await root(rootDir);
    let interceptedMode: boolean | undefined;
    __setFsSafeTestHooksForTest({
      async beforeRootListObservation(directoryPath, observedWithFileTypes) {
        expect(directoryPath).toBe(selected);
        interceptedMode = observedWithFileTypes;
        await replaceDirectoryWithAlias(selected, outside);
      },
    });

    const listing = withFileTypes
      ? capability.list("selected", { withFileTypes: true })
      : capability.list("selected");
    await expect(listing).rejects.toMatchObject({ code: "path-mismatch" });
    expect(interceptedMode).toBe(withFileTypes);
    await expect(fs.readdir(outside)).resolves.toEqual(["outside-secret"]);
  },
);
