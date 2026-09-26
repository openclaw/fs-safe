import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { watchBinding } from "../src/watch-native.js";

const exec = promisify(execFile);
const eventsAvailable = !!watchBinding("auto");
if (process.env.FS_SAFE_TEST_WATCH_EVENTS === "1" && !eventsAvailable) {
  throw new Error("persistent events proof requires the freshly built addon");
}
let directory: string;
beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-persistent-")));
  for (const name of ["edit-poll", "edit-events", "queued"]) await fs.writeFile(path.join(directory, name), "before");
  // FSEvents can coalesce creation and edits under a pre-subscription event ID.
  if (process.platform === "darwin") await new Promise(resolve => setTimeout(resolve, 3000));
});
afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

async function run(mode: string, body: string): Promise<string> {
  const preamble = `
    import assert from "node:assert/strict";
    import { writeFileSync } from "node:fs";
    import fs from "node:fs/promises";
    import path from "node:path";
    import { root } from "@openclaw/fs-safe/root";
    import { watch } from "@openclaw/fs-safe/watch";
    import { getNativeBinding } from "./dist/native.js";
    import { __setFsSafeTestHooksForTest as hooks } from "@openclaw/fs-safe/test-hooks";
    const directory = process.argv[1];
    const mode = process.argv[2];
    const capability = await root(directory);
    const options = { mode, scopes: [{ path: "", kind: "tree" }],
      intervalMs: mode === "poll" ? 20 : 60000, onInvalidate() {} };
    const make = (extra = {}) => watch(capability, { ...options, ...extra });
  `;
  const child = await exec(process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "-e", preamble + body, directory, mode],
    { cwd: new URL("..", import.meta.url), env: { ...process.env, NODE_ENV: "test" }, timeout: 5000, killSignal: "SIGKILL" });
  expect(child.stderr).toBe("");
  return child.stdout.trim();
}

describe.each(["poll", "events"])("watch persistent (%s)", mode => {
  const test = mode === "events" && !eventsAvailable ? it.skip : it;
  test("exits after ready without closing a non-persistent subscription", async () => {
    expect(await run(mode, `
      const subscription = make({ persistent: false });
      await subscription.ready;
      assert.equal(subscription.health().state, "ready");
      assert.equal(subscription.health().mode, mode);
      if (mode === "events") assert.equal(getNativeBinding().watchThreadCount(), 1);
      console.log("ready-open");
    `)).toBe("ready-open");
  });

  test.each([undefined, true])("stays alive until close with persistent=%s", async persistent => {
    expect(await run(mode, `
      const subscription = make(${persistent === undefined ? "{}" : "{ persistent: true }"});
      await subscription.ready;
      // Only the subscription can keep this unref'd close timer reachable.
      setTimeout(() => { void subscription.close().then(() => console.log("closed")); }, 200).unref();
    `)).toBe("closed");
  });

  test.each([false, true])("closing the persistent peer permits exit (created first: %s)", async persistentFirst => {
    expect(await run(mode, `
      const pair = [${persistentFirst}, ${!persistentFirst}].map(persistent => make({ persistent }));
      await Promise.all(pair.map(owner => owner.ready));
      const persistent = pair[${persistentFirst ? 0 : 1}];
      const nonPersistent = pair[${persistentFirst ? 1 : 0}];
      setTimeout(() => { void persistent.close().then(() => {
        assert.ok(["ready", "reconciling"].includes(nonPersistent.health().state));
        if (mode === "events") assert.equal(getNativeBinding().watchThreadCount(), 1);
        console.log("peer-open");
      }); }, 200).unref();
    `)).toBe("peer-open");
  });

  test("delivers an edit while an independent timer keeps the process alive", async () => {
    expect(await run(mode, `
      let edited = false;
      const keepAlive = setTimeout(() => { throw new Error("missing invalidation"); }, 3000);
      const subscription = make({ persistent: false, onInvalidate(value) {
        if (!edited) return;
        assert.ok(!value.changes || value.changes.some(change => change.path === "edit-" + mode));
        clearTimeout(keepAlive);
        console.log("delivered");
        edited = false;
      } });
      await subscription.ready;
      edited = true;
      await fs.writeFile(path.join(directory, "edit-" + mode), "changed-" + process.pid);
    `)).toBe("delivered");
  });

  test.each(["starting", "reconciling"])("does not retain the loop during %s", async state => {
    expect(await run(mode, `
      const stall = () => hooks({ beforeWatchRegistration() {
        assert.equal(subscription.health().state, "${state}");
        console.log("${state}");
        return new Promise(() => {});
      } });
      ${state === "starting" ? "stall();" : ""}
      const subscription = make({ persistent: false });
      ${state === "reconciling" ? "await subscription.ready; stall(); void subscription.reconcile();" : ""}
    `)).toBe(state);
  });
});

it.skipIf(!eventsAvailable)("cleanly exits with native delivery queued on an open non-persistent owner", async () => {
  expect(await run("events", `
    const subscription = make({ persistent: false });
    await subscription.ready;
    for (let cycle = 0; cycle < 3; cycle++) {
      writeFileSync(path.join(directory, "queued"), String(cycle));
      // Let the native thread enqueue while JS cannot drain its callback queue.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
    }
    assert.equal(getNativeBinding().watchThreadCount(), 1);
    console.log("queued-open");
  `)).toBe("queued-open");
});

it.skipIf(!eventsAvailable)("joins the shared native hub when an unclosed worker environment exits", async () => {
  expect(await run("events", `
    const { Worker } = await import("node:worker_threads");
    const { once } = await import("node:events");
    for (let cycle = 0; cycle < 3; cycle++) {
      const worker = new Worker(new URL("./test/fixtures/watch-persistent-worker.mjs", import.meta.url), {
        workerData: directory, execArgv: [],
      });
      const [code] = await once(worker, "exit");
      assert.equal(code, 0);
      assert.equal(getNativeBinding().watchThreadCount(), 0);
    }
    console.log("joined");
  `)).toBe("joined");
});
