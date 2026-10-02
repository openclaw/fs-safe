import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root, configureFsSafeNative } from "../src/index.js";
import { createFileHandle, createFileSync } from "../src/create.js";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { AtomicIo, runAsync, runSync } from "../src/atomic-io.js";
import { writeTempFile } from "../src/replace-file-descriptor.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink.js";
import { allowWindowsFilesystemStalls, useRealTempDirs } from "./helpers/vitest.js";

allowWindowsFilesystemStalls();
const { tempRoot } = useRealTempDirs();
afterEach(() => configureFsSafeNative({ mode: "auto" }));

it.each(["async string", "async numeric", "sync string", "sync numeric"])(
  "preserves nonexclusive adapter opens (%s)", async (operation, context) => {
    const directory = await tempRoot("fs-safe-nonexclusive-");
    const target = path.join(directory, "target"), leaf = path.join(directory, "leaf");
    await fs.writeFile(target, "keep");
    await fileSymlinkOrSkip(target, leaf, context);
    const flags = operation.endsWith("string") ? "a"
      : fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_APPEND;
    const file = operation.startsWith("async")
      ? await runAsync(AtomicIo.async(fs).open(leaf, flags))
      : runSync(AtomicIo.sync(fsSync).open(leaf, flags));
    try { expect((await file.statExact()).isFile()).toBe(true); }
    finally { await file.close(); }
    expect(await fs.readFile(target, "utf8")).toBe("keep");
  },
);

describe.each(["auto", "off"] as const)("exclusive creation preserves dangling leaves (%s)", mode => {
  describe.each(["absolute", "relative"])("%s outside target", kind => {
    it.each([
      "root.create", "root.write-exclusive", "root.writeJson-exclusive", "createFileSync", "createFileHandle",
      "lock async", "lock sync", "root lock async", "root lock sync", "pinned create",
      "atomic stage async", "atomic stage sync",
    ])("%s", async (operation, context) => {
      configureFsSafeNative({ mode });
      const base = await tempRoot("fs-safe-exclusive-dangling-");
      const directory = path.join(base, "root", "nested");
      await fs.mkdir(directory, { recursive: true });
      const capability = await root(path.join(base, "root"));
      const target = path.join(base, "outside");
      const leaf = path.join(directory, "leaf");
      const link = await fileSymlinkOrSkip(kind === "absolute" ? target : path.join("..", "..", "outside"), leaf, context);
      const attempt = async () => {
        if (operation === "root.create") return await capability.create("nested/leaf", "data");
        if (operation === "root.write-exclusive") return await capability.write("nested/leaf", "data", { overwrite: false, mkdir: true });
        if (operation === "root.writeJson-exclusive") return await capability.writeJson("nested/leaf", { data: true }, { overwrite: false });
        if (operation === "createFileSync") return createFileSync(leaf).close();
        if (operation === "createFileHandle") return await (await createFileHandle(leaf)).close();
        if (operation === "pinned create") return await runPinnedWriteHelper({
          rootPath: directory, relativeParentPath: "", basename: "leaf", mode: 0o600, mkdir: false,
          overwrite: false, input: { kind: "buffer", data: "data" },
        });
        if (operation.startsWith("atomic stage")) {
          // The stage owner supplies this name. Random public stage names are
          // lower risk; this verifies a collision at their shared creation seam.
          const params = { tempPath: leaf, content: "data", mode: 0o600, sync: false };
          const staged = operation.endsWith("async")
            ? await runAsync(writeTempFile(AtomicIo.async(fs), params))
            : runSync(writeTempFile(AtomicIo.sync(fsSync), params));
          await staged.file.close();
          return;
        }
        const options = {
          lockPath: leaf, payload: () => ({ owner: "test" }),
          retry: { retries: 0, minTimeout: 0, maxTimeout: 0 },
          ...(operation.startsWith("root") ? { lockRoot: capability } : {}),
        };
        const held = operation.endsWith("async")
          ? await acquireFileLock(path.join(directory, "state"), options)
          : acquireFileLockSync(path.join(directory, "state"), options);
        await held.release();
      };
      await expect(attempt()).rejects.toBeDefined();
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(leaf)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(leaf)).toBe(link);
    });
  });
});
