import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

describe.skipIf(process.platform === "win32")("fallback final file mode", () => {
  it.each([false, true].flatMap((overwrite) => ["buffer", "stream"].map((kind) => ({ overwrite, kind }))))(
    "applies mode after $kind content and before syncing (overwrite=$overwrite)",
    async ({ overwrite, kind }) => {
      configureFsSafeNative({ mode: "off" });
      const rootPath = await tempRoot("fs-safe-pinned-file-mode-");
      await fs.chown(rootPath, process.geteuid!(), process.getegid!());
      const target = path.join(rootPath, "target");
      const events: string[] = [];
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (!(await handle.stat()).isFile()) return handle;
        const chmod = handle.chmod.bind(handle);
        const writeFile = handle.writeFile.bind(handle);
        const write = handle.write.bind(handle);
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "chmod").mockImplementation(async (mode) => {
          events.push("chmod");
          await chmod(mode);
        });
        vi.spyOn(handle, "writeFile").mockImplementation(async (...args) => {
          events.push("write");
          await writeFile(...args);
        });
        vi.spyOn(handle, "write").mockImplementation((async (...args: Parameters<typeof handle.write>) => {
          events.push("write");
          return await write(...args);
        }) as typeof handle.write);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          events.push("sync");
          await sync();
        });
        return handle;
      });

      await runPinnedWriteHelper({
        rootPath, relativeParentPath: "", basename: "target", mkdir: false, overwrite,
        mode: 0o4600,
        input: kind === "buffer" ? { kind: "buffer", data: "synthetic mode" }
          : { kind: "stream", stream: Readable.from(["synthetic ", "mode"]) },
      });

      expect((await fs.stat(target)).mode & 0o7777).toBe(0o4600);
      expect(events.filter((event) => event === "chmod")).toHaveLength(1);
      expect(events.lastIndexOf("write")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("chmod")).toBeGreaterThan(events.lastIndexOf("write"));
      expect(events.indexOf("sync")).toBeGreaterThan(events.indexOf("chmod"));
      expect(await fs.readFile(target, "utf8")).toBe("synthetic mode");
    },
  );
});
