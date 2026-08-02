import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceFileAtomic } from "../src/atomic.js";
import { fileStore } from "../src/file-store.js";
import { writeJson } from "../src/json.js";
import { jsonStore } from "../src/json-store.js";
import { DEFAULT_ROOT_MAX_BYTES, root } from "../src/root.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("documented defaults observed on real files", () => {
  it("uses the Root read, write, move, JSON, and writable-open defaults", async () => {
    const rootDir = await tempRoot("fs-safe-doc-root-defaults-");
    const scoped = await root(rootDir);

    await scoped.write("missing/file.txt", "x");
    await expect(scoped.readText("missing/file.txt")).resolves.toBe("x");
    await expect(scoped.write("still-missing/file.txt", "x", { mkdir: false })).rejects.toMatchObject({
      code: "not-found",
      category: "operational",
    });
    await expect(
      scoped.copyIn("copy-missing/file.txt", path.join(rootDir, "missing/file.txt"), {
        mkdir: false,
      }),
    ).rejects.toMatchObject({ code: "not-found", category: "operational" });

    await scoped.write("state.txt", "first");
    await scoped.write("state.txt", "second");
    await expect(scoped.readText("state.txt")).resolves.toBe("second");

    await scoped.writeJson("state.json", { ok: true });
    await expect(fs.readFile(path.join(rootDir, "state.json"), "utf8")).resolves.toBe(
      '{"ok":true}\n',
    );

    await scoped.write("source.txt", "source");
    await scoped.write("target.txt", "target");
    await expect(scoped.move("source.txt", "target.txt")).rejects.toMatchObject({
      code: "already-exists",
      category: "policy",
    });

    const writable = await scoped.openWritable("state.txt");
    try {
      await writable.handle.writeFile("replacement");
    } finally {
      await writable.handle.close();
    }
    await expect(scoped.readText("state.txt")).resolves.toBe("replacement");
  });

  it("enforces Root's default 16 MiB cap without a maxBytes option", async () => {
    const rootDir = await tempRoot("fs-safe-doc-root-limit-");
    const filePath = path.join(rootDir, "oversized.bin");
    await fs.writeFile(filePath, Buffer.alloc(DEFAULT_ROOT_MAX_BYTES + 1));
    const scoped = await root(rootDir);

    await expect(scoped.read("oversized.bin")).rejects.toMatchObject({
      code: "too-large",
      category: "policy",
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinks and hardlinks by default",
    async () => {
      const rootDir = await tempRoot("fs-safe-doc-link-defaults-");
      const filePath = path.join(rootDir, "file.txt");
      await fs.writeFile(filePath, "data");
      await fs.symlink(filePath, path.join(rootDir, "symlink.txt"));
      await fs.link(filePath, path.join(rootDir, "hardlink.txt"));
      const scoped = await root(rootDir);

      await expect(scoped.read("symlink.txt")).rejects.toMatchObject({ code: "symlink" });
      await expect(scoped.read("hardlink.txt")).rejects.toMatchObject({ code: "hardlink" });
    },
  );

  it("uses distinct standalone and store JSON newline defaults", async () => {
    const rootDir = await tempRoot("fs-safe-doc-json-defaults-");
    const standalone = path.join(rootDir, "standalone.json");
    await writeJson(standalone, { value: 1 });
    await expect(fs.readFile(standalone, "utf8")).resolves.toBe('{\n  "value": 1\n}');

    const store = fileStore({ rootDir: path.join(rootDir, "store") });
    await store.writeJson("value.json", { value: 1 });
    await expect(fs.readFile(path.join(rootDir, "store/value.json"), "utf8")).resolves.toBe(
      '{\n  "value": 1\n}\n',
    );

    const state = jsonStore<{ value: number }>({ filePath: path.join(rootDir, "state/value.json") });
    await state.write({ value: 1 });
    await expect(fs.readFile(path.join(rootDir, "state/value.json"), "utf8")).resolves.toBe(
      '{\n  "value": 1\n}\n',
    );
  });

  it.runIf(process.platform !== "win32")(
    "applies the documented atomic and FileStore mode defaults",
    async () => {
      const rootDir = await tempRoot("fs-safe-doc-mode-defaults-");
      const atomicPath = path.join(rootDir, "atomic/state.txt");
      await replaceFileAtomic({ filePath: atomicPath, content: "state" });
      expect((await fs.stat(path.dirname(atomicPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(atomicPath)).mode & 0o777).toBe(0o600);

      const store = fileStore({ rootDir: path.join(rootDir, "store") });
      const storedPath = await store.write("nested/value.txt", "value");
      expect((await fs.stat(path.dirname(storedPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(storedPath)).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses 0o600 for a new Root file and preserves an existing mode",
    async () => {
      const rootDir = await tempRoot("fs-safe-doc-root-mode-");
      const filePath = path.join(rootDir, "state.txt");
      const scoped = await root(rootDir);
      await scoped.write("state.txt", "new");
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);

      await fs.chmod(filePath, 0o644);
      await scoped.write("state.txt", "replacement");
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
    },
  );

  it("classifies documented non-empty and reentrant-update errors by observation", async () => {
    const rootDir = await tempRoot("fs-safe-doc-error-defaults-");
    const scoped = await root(rootDir);
    await scoped.mkdir("full");
    await scoped.write("full/file.txt", "x");
    await expect(scoped.remove("full")).rejects.toMatchObject({
      code: "not-empty",
      category: "operational",
    });

    const state = jsonStore<{ count: number }>({ filePath: path.join(rootDir, "state.json") });
    await expect(
      state.update(async () => {
        await state.updateOr({ count: 0 }, (current) => current);
        return { count: 1 };
      }),
    ).rejects.toMatchObject({ code: "store-reentrant-update", category: "policy" });
  });

  it.runIf(
    process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      process.getuid() !== 0,
  )("maps an actual permission-denied unlink to not-removable", async () => {
    const rootDir = await tempRoot("fs-safe-doc-not-removable-");
    const filePath = path.join(rootDir, "locked.txt");
    await fs.writeFile(filePath, "locked");
    const scoped = await root(rootDir);
    await fs.chmod(rootDir, 0o500);
    try {
      await expect(scoped.remove("locked.txt")).rejects.toMatchObject({
        code: "not-removable",
        category: "operational",
      });
    } finally {
      await fs.chmod(rootDir, 0o700);
    }
  });
});
