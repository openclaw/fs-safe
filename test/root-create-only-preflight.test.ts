import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { getNativeBinding } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { configureFsSafeNative({ mode: "auto" }); __setFsSafeTestHooksForTest(); vi.restoreAllMocks(); });

it.each(["off", "auto"] as const)("create-only keeps type, alias, hardlink, and root guards (native %s)", async (mode) => {
  configureFsSafeNative({ mode });
  const directory = await tempRoot("root-create-only-"), capability = await root(directory);
  const target = path.join(capability.rootReal, "target");
  await fs.writeFile(target, "owner");
  const afterOpen = vi.fn();
  __setFsSafeTestHooksForTest({ afterOpen });
  await expect(capability.create("target", "replacement")).rejects.toMatchObject({ code: "already-exists" });
  await expect(capability.write("target", "replacement", { overwrite: false })).rejects.toMatchObject({ code: "already-exists" });
  expect(afterOpen).not.toHaveBeenCalled();
  await expect(fs.readFile(target, "utf8")).resolves.toBe("owner");
  await fs.mkdir(path.join(capability.rootReal, "directory"));
  await expect(capability.create("directory", "replacement")).rejects.toMatchObject({
    code: process.platform === "win32" && !getNativeBinding() ? "already-exists" : "not-file",
  });
  await fs.link(target, `${target}.link`);
  await expect(capability.create("target", "replacement")).rejects.toMatchObject({ code: "path-alias" });
  await expect(capability.create("../escape", "replacement")).rejects.toMatchObject({ code: "outside-workspace" });
  const denied = await root(directory, { denyMutations: { paths: [target] } });
  await expect(denied.create("target", "replacement")).rejects.toMatchObject({ code: "denied-path" });
  __setFsSafeTestHooksForTest();
  await fs.rename(directory, `${directory}.old`);
  try {
    await fs.mkdir(directory);
    await expect(capability.create("new", "replacement")).rejects.toMatchObject({ code: "path-mismatch" });
  } finally { await fs.rm(`${directory}.old`, { recursive: true }); }
});

it.skipIf(process.platform === "win32")("create-only rejects an escaped alias and supports an in-root parent alias", async () => {
  const capability = await root(await tempRoot("root-create-alias-"));
  const outside = await tempRoot("root-create-outside-");
  await fs.symlink(outside, path.join(capability.rootReal, "outside"));
  await expect(capability.create("outside/file", "no")).rejects.toMatchObject({ code: "path-alias" });
  await capability.mkdir("actual");
  await fs.symlink("actual", path.join(capability.rootReal, "alias"));
  await capability.create("alias/file", "yes");
  await expect(fs.readFile(path.join(capability.rootReal, "actual/file"), "utf8")).resolves.toBe("yes");
});
