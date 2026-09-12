import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { extractNativeArchive } from "../src/archive-native.js";
import { resolveExtractLimits, resolveTarMeterLimits } from "../src/archive-limits.js";
import type { NativeBinding } from "../src/native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

it("cancels native extraction after inspection completes on the same deadline", async () => {
  const dir = await tempRoot("fs-safe-native-cancel-");
  const archivePath = path.join(dir, "fixture.tar");
  const destDir = path.join(dir, "output");
  await fs.writeFile(archivePath, tarFixture([{ path: "entry", body: "payload" }]));
  await fs.mkdir(destDir);
  await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
  const controller = new AbortController();
  const abortError = new Error("native extraction aborted");
  type Task = { complete: boolean; abort(): void };
  const tasks = new WeakMap<AbortSignal, Task[]>();
  // N-API 3.12 keeps a stack per signal and stops abort dispatch at a completed task.
  const registerTask = (signal: AbortSignal, task: Task) => {
    const stack = tasks.get(signal) ?? [];
    stack.push(task);
    tasks.set(signal, stack);
    signal.onabort = () => {
      for (const entry of stack) {
        if (entry.complete) return;
        entry.abort();
      }
    };
  };
  let extractionAborted = false;
  let release: (error: Error) => void = () => {};
  let entered: () => void = () => {};
  const extractionEntered = new Promise<void>((resolve) => { entered = resolve; });
  const binding = {
    async inspectArchiveNative(...args: Parameters<NativeBinding["inspectArchiveNative"]>) {
      registerTask(args[3], { complete: true, abort() {} });
      return [{ index: 0, path: "entry", kind: "file", size: 7, mode: 0o644 }];
    },
    extractArchiveNative(...args: Parameters<NativeBinding["extractArchiveNative"]>) {
      const pending = new Promise<void>((_resolve, reject) => { release = reject; });
      registerTask(args[5], { complete: false, abort() {
        extractionAborted = true;
        release(abortError);
      } });
      entered();
      return pending;
    },
  } as NativeBinding;
  const limits = resolveExtractLimits();
  const operation = extractNativeArchive({
    binding, archivePath, destDir, kind: "tar", limits, tarLimits: resolveTarMeterLimits(limits),
    deadline: {
      signal: controller.signal,
      check: () => controller.signal.throwIfAborted(),
      ownDestinationMutation: async (run) => await run(),
      waitForDestinationMutations: async () => {},
      dispose() {},
    },
  }).then(() => undefined, (error: unknown) => error);
  try {
    await Promise.race([extractionEntered, operation.then((error) => { throw error; })]);
    controller.abort(abortError);
    expect(extractionAborted).toBe(true);
    expect(await operation).toBe(abortError);
    expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
    expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
  } finally {
    // Drain a broken implementation as well, without leaving its private stage live.
    release(abortError);
    await operation;
  }
});
