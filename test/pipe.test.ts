import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createPipe } from "../src/pipe.js";
import { loadTestNative } from "./helpers/native-probe.js";
// The same syscall assertions run in the main thread and a real Worker.
import { provePipe } from "./fixtures/pipe-proof.mjs";

const supported = ["linux", "darwin", "freebsd"].includes(process.platform);
const nativeAvailable = supported && Boolean(loadTestNative("optional")?.createPipe);
const completed = [
  "owned-anonymous-pipe", "reopen-and-eof", "idempotent-close",
  "close-on-exec", "stream-native-close", "1000-cycles-no-leak",
];

describe("pipe import and availability", () => {
  it("imports lazily with a stable export and fails closed when disabled", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      let loads = 0;
      process.dlopen = () => { loads++; throw new Error('unexpected addon load'); };
      const { createPipe } = await import('@openclaw/fs-safe/pipe');
      assert.equal(typeof createPipe, 'function');
      assert.equal(loads, 0);
      assert.throws(createPipe, { name: 'FsSafeError', code: ${JSON.stringify(supported ? "helper-unavailable" : "unsupported-platform")} });
      assert.equal(loads, 0);
    `], { encoding: "utf8", env: { ...process.env, FS_SAFE_NATIVE_MODE: "off" }, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.runIf(!supported)("rejects unsupported platforms with the existing typed code", () => {
    expect(createPipe).toThrowError(expect.objectContaining({ name: "FsSafeError", code: "unsupported-platform" }));
  });
});

describe.runIf(supported && (nativeAvailable || process.env.FS_SAFE_NATIVE_MODE === "require"))(
  "native anonymous pipes", () => {
    it("satisfies the real descriptor contract on the main thread", async () => {
      expect(nativeAvailable).toBe(true);
      expect(await provePipe()).toEqual(completed);
    });

    it("satisfies the same contract in a real Worker without fd-registry warnings", async () => {
      const worker = new Worker(new URL("./fixtures/pipe-proof.mjs", import.meta.url), { stdout: true, stderr: true });
      let result: { completed: string[]; warnings: string[] } | undefined;
      let stderr = "";
      worker.stdout.resume();
      worker.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      worker.on("message", message => { result = message; });
      try {
        const [exitCode] = await once(worker, "exit", { signal: AbortSignal.timeout(15_000) });
        expect(exitCode).toBe(0);
        expect(result).toEqual({ completed, warnings: [] });
        expect(stderr).not.toMatch(/File descriptor .*closed but not opened in unmanaged mode/u);
      } finally { await worker.terminate(); }
    }, 20_000);
  },
);
