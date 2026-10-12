import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import * as config from "../src/config.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import * as loader from "../src/native.js";
// @ts-expect-error shared proof also runs against the compiled public configuration.
import { nativeStatusProof } from "./fixtures/native-status.mjs";

const reasons = ["not-probed", "loaded", "disabled", "unsupported-target",
  "package-missing", "load-failed", "capability-missing"].sort();

it("reports every cached native outcome through the public status shape", async () => {
  const results = await nativeStatusProof({ config: { ...config, __resetFsSafeNativeConfigForTest }, loader });
  expect([...new Set(results.map((value: config.FsSafeNativeStatus) => value.reason))].sort()).toEqual(reasons);
});

it("keeps the status cache and configuration independent in a real Worker", async () => {
  config.configureFsSafeNative({ mode: "off" });
  const worker = new Worker(new URL("./fixtures/native-status.mjs", import.meta.url));
  try {
    const [[results], [exitCode]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
    expect([...new Set(results.map((value: config.FsSafeNativeStatus) => value.reason))].sort()).toEqual(reasons);
    expect(results[0]).toMatchObject({ reason: "not-probed", mode: "auto", modeSource: "default" });
    expect(await config.getFsSafeNativeStatus()).toMatchObject({ reason: "disabled", mode: "off" });
    expect(exitCode).toBe(0);
  } finally {
    __resetFsSafeNativeConfigForTest();
    await worker.terminate();
  }
});

it("keeps a config-only import lazy and shares its later probe with native operations", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { configureFsSafeNative, getFsSafeNativeStatus } from '@openclaw/fs-safe/config';
    const require = createRequire(import.meta.url);
    assert.equal(Object.keys(require.cache).some(file => file.endsWith('.node')), false);
    configureFsSafeNative({ mode: 'require' });
    const pending = getFsSafeNativeStatus();
    assert.equal(typeof pending.then, 'function');
    assert.equal((await pending).reason, 'not-probed');
    assert.equal(Object.keys(require.cache).some(file => file.endsWith('.node')), false);
    const first = await getFsSafeNativeStatus({ probe: true });
    assert.notEqual(first.reason, 'not-probed');
    const loader = await import('./dist/native.js');
    assert.equal(loader.getNativeFallbackDiagnostic().reason, first.reason);
    assert.deepEqual(await getFsSafeNativeStatus({ probe: true }), first);
    console.log('shared lazy status');
  `;
  expect(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL("../", import.meta.url), encoding: "utf8",
  }).trim()).toBe("shared lazy status");
});
