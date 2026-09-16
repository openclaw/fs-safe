import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { __loadBundledNativeForTest } from "../src/native.js";
import { useSuiteFixture } from "./helpers/suite-fixture.js";

let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch {
  // Ordinary JavaScript lanes omit native artifacts. Required-native CI must
  // fail if its addon is absent rather than silently skipping this regression.
}

type WorkerResult = { kind: "result"; completed: string[]; warnings: string[] };

describe.runIf(nativeAvailable || process.env.FS_SAFE_NATIVE_MODE === "require")(
  "native descriptor ownership in Node Workers",
  () => {
    let directory: string | undefined;
    const run = useSuiteFixture(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-worker-fds-"));
      await fs.writeFile(path.join(directory, "sentinel.txt"), "node-owned");
      return await fs.realpath(directory);
    }, async () => {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    });

    it("closes native descriptors without warnings and preserves Node's fd tracker", () => run(async directory => {
      expect(nativeAvailable).toBe(true);
      const identity = await fs.stat(path.join(directory, "sentinel.txt"), { bigint: true });
      const worker = new Worker(new URL("./fixtures/native-worker-fd-ownership.mjs", import.meta.url), {
        workerData: { directory },
        stdout: true,
        stderr: true,
      });
      let result: WorkerResult | undefined;
      let sentinelFd: number | undefined;
      let stderr = "";
      worker.stdout.resume();
      worker.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      worker.on("message", (message: WorkerResult | { kind: "sentinel"; fd: number }) => {
        if (message.kind === "sentinel") sentinelFd = message.fd;
        else result = message;
      });
      const stillOwnsSentinel = () => {
        if (sentinelFd === undefined) return false;
        try {
          const current = fsSync.fstatSync(sentinelFd, { bigint: true });
          return current.dev === identity.dev && current.ino === identity.ino;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EBADF") return false;
          throw error;
        }
      };
      try {
        const [exitCode] = await once(worker, "exit", { signal: AbortSignal.timeout(15_000) });
        expect(exitCode).toBe(0);
        expect(result?.completed).toEqual([
          "write", "create", "create-stream", "append", "open-writable", "copy-in",
          "move", "private-sibling", "create-collision",
          ...(process.platform === "win32" ? [] : ["node-parent-staging"]),
        ]);
        expect(result?.warnings).toEqual([]);
        expect(stderr).not.toMatch(/File descriptor .*closed but not opened in unmanaged mode/u);
        expect(sentinelFd).toBeTypeOf("number");
        // Descriptor numbers can be reused after Worker exit. Either EBADF or a
        // different file identity proves the original Node-owned fd was closed.
        expect(stillOwnsSentinel()).toBe(false);
      } finally {
        await worker.terminate();
        if (sentinelFd !== undefined && stillOwnsSentinel()) fsSync.closeSync(sentinelFd);
      }
    }), 20_000);
  },
);
