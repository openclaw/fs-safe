import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafePython, root as openRoot } from "../src/index.js";
import { __resetPinnedPythonWorkerForTest } from "../src/pinned-python.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";

const tempDirs = new Set<string>();

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafePython({ mode: "auto", pythonPath: undefined });
  __resetPinnedPythonWorkerForTest();
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("pinned write fsync compatibility", () => {
  it.runIf(process.platform !== "win32")(
    "treats EPERM from fallback file sync as best effort",
    async () => {
      configureFsSafePython({ mode: "off" });
      const root = await tempRoot("fs-safe-pinned-write-fsync-eperm-");
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
        );
        return handle;
      });

      await expect(
        runPinnedWriteHelper({
          rootPath: root,
          relativeParentPath: "",
          basename: "created.txt",
          mkdir: true,
          mode: 0o600,
          overwrite: true,
          input: { kind: "buffer", data: "created", encoding: "utf8" },
        }),
      ).resolves.toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
      await expect(fs.readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe("created");
    },
  );

  it.runIf(process.platform !== "win32")(
    "treats EPERM from Python helper file sync as best effort",
    async () => {
      const rootDir = await tempRoot("fs-safe-python-fsync-eperm-");
      const wrapperPath = path.join(rootDir, "python-wrapper.mjs");
      await fs.writeFile(
        wrapperPath,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("-c") + 1;
if (sourceIndex <= 0 || sourceIndex >= args.length) process.exit(64);
const source = args[sourceIndex];
args[sourceIndex] = source.replace(
  "    try: os.fsync(fd)",
  "    try: raise OSError(errno.EPERM, 'test fsync permission failure')",
);
if (args[sourceIndex] === source) process.exit(65);
const child = spawn("python3", args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`,
        { mode: 0o700 },
      );
      await fs.chmod(wrapperPath, 0o700);
      configureFsSafePython({ mode: "require", pythonPath: wrapperPath });
      const scoped = await openRoot(rootDir);

      await expect(scoped.write("created.txt", "payload")).resolves.toBeUndefined();
      await expect(fs.readFile(path.join(rootDir, "created.txt"), "utf8")).resolves.toBe(
        "payload",
      );
    },
  );
});
