import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { loadTestNative } from "./helpers/native-probe.js";

const native = process.platform === "win32" ? loadTestNative("required-env") : undefined;
const fixture = new URL("./fixtures/windows-native-private-proof.mjs", import.meta.url);

describe.runIf(native)("Windows native private creation", () => {
  it("preserves private ACLs, exclusive creation and native-owned descriptors on the main thread", () => {
    const proof = JSON.parse(execFileSync(process.execPath, [fileURLToPath(fixture)], {
      encoding: "utf8", timeout: 30_000,
    }));
    expect(proof).toEqual({ arch: process.arch, isMainThread: true, privateCreation: true, nativeClose: true });
  }, 35_000);

  it("preserves the same public contract in a real Worker", async () => {
    const worker = new Worker(fixture);
    try {
      const [message, exited] = await Promise.all([
        once(worker, "message", { signal: AbortSignal.timeout(30_000) }),
        once(worker, "exit", { signal: AbortSignal.timeout(30_000) }),
      ]);
      expect(message[0]).toEqual({ arch: process.arch, isMainThread: false, privateCreation: true, nativeClose: true });
      expect(exited[0]).toBe(0);
    } finally {
      await worker.terminate();
    }
  }, 35_000);
});
