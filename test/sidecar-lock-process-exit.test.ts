import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { useTempDirs } from "./helpers/vitest.js";
import { useSuiteFixture } from "./helpers/suite-fixture.js";

const { tempRoot } = useTempDirs();
const exec = promisify(execFile);
const preamble = `
  import assert from "node:assert/strict";
  import fs from "node:fs/promises";
  import path from "node:path";
  import { root } from "@openclaw/fs-safe/root";
  import { acquireFileLock, createFileLockManager } from "@openclaw/fs-safe/file-lock";
  const directory = process.argv[1];
  const targetPath = path.join(directory, "state.json");
  const capability = await root(directory);
  const options = { lockRoot: capability, payload: () => ({ owner: "caller" }) };
`;

async function runChild(directory: string, script: string): Promise<string> {
  const { stdout, stderr } = await exec(
    process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "-e", preamble + script, directory],
    { cwd: new URL("..", import.meta.url), timeout: 4_000, killSignal: "SIGKILL" },
  );
  expect(stderr).toBe("");
  return stdout.trim();
}

async function expectAbsent(directory: string, name = "state.json.lock"): Promise<void> {
  await expect(fs.lstat(path.join(directory, name))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("sidecar lock natural process exit", () => {
  it.each(["Root held", "raw held", "Root released"])("cleans %s locks", async (kind) => {
    const directory = await tempRoot("fs-safe-lock-exit-");
    await runChild(directory, `
      const lock = await acquireFileLock(targetPath, {
        ...options, lockRoot: ${kind === "raw held" ? "undefined" : "capability"},
      });
      assert.equal(await lock.verifyStillHeld(), true);
      ${kind === "Root released" ? "await lock.release();" : ""}
    `);
    await expectAbsent(directory);
  });

  it.each(["rewritten", "replacement"])("preserves a %s Root sidecar", async (kind) => {
    const directory = await tempRoot("fs-safe-lock-exit-changed-");
    const replacement = await runChild(directory, `
      const lock = await acquireFileLock(targetPath, options);
      const raw = await fs.readFile(lock.lockPath, "utf8");
      ${kind === "replacement" ? "await fs.unlink(lock.lockPath);" : ""}
      const changed = raw.trimEnd() + "\\n";
      await fs.writeFile(lock.lockPath, changed);
      console.log(JSON.stringify(changed));
    `);
    await expect(fs.readFile(path.join(directory, "state.json.lock"), "utf8"))
      .resolves.toBe(JSON.parse(replacement));
  });

  it.each(["Root", "raw"])("keeps an unchanged %s sidecar acquired with retainOnExit", async (kind) => {
    const directory = await tempRoot("fs-safe-lock-exit-retain-");
    await runChild(directory, `
      const lock = await acquireFileLock(targetPath, {
        ...options, retainOnExit: true,
        lockRoot: ${kind === "raw" ? "undefined" : "capability"},
      });
      assert.equal(await lock.verifyStillHeld(), true);
    `);
    const raw = await fs.readFile(path.join(directory, "state.json.lock"), "utf8");
    expect(JSON.parse(raw)).toEqual({ owner: "caller" });
  });

  it("attempts failed Root cleanup once without an unhandled rejection or shutdown loop", async () => {
    const directory = await tempRoot("fs-safe-lock-exit-failure-");
    const output = await runChild(directory, `
      const lock = await acquireFileLock(targetPath, options);
      const raw = await fs.readFile(lock.lockPath, "utf8");
      await acquireFileLock(path.join(directory, "healthy.json"), options);
      const remove = capability.remove.bind(capability);
      let removals = 0;
      let cycles = 0;
      capability.remove = async (relativePath, ...args) => {
        if (relativePath !== "state.json.lock") return await remove(relativePath, ...args);
        removals++;
        throw Object.assign(new Error("injected Root.remove failure"), { code: "EIO" });
      };
      process.on("beforeExit", () => { cycles++; });
      process.on("exit", () => console.log(JSON.stringify({ removals, cycles, raw })));
    `);
    const result = JSON.parse(output);
    expect(result).toMatchObject({ removals: 1, cycles: 2 });
    await expect(fs.readFile(path.join(directory, "state.json.lock"), "utf8"))
      .resolves.toBe(result.raw);
    await expectAbsent(directory, "healthy.json.lock");
  });

  it("force-releases a reentrant holder and clears its compromise timer", async () => {
    const directory = await tempRoot("fs-safe-lock-exit-reentrant-");
    const output = await runChild(directory, `
      const manager = createFileLockManager("reentrant");
      const nestedOptions = {
        ...options, reentrantOwner: "owner", compromiseCheckIntervalMs: 1_000,
        onCompromised: () => { throw new Error("unexpected compromise"); },
      };
      await manager.acquire(targetPath, nestedOptions);
      await manager.acquire(targetPath, nestedOptions);
      const held = [...globalThis[Symbol.for("fsSafe.sidecarLockManagers")]
        .get("reentrant").held.values()][0];
      assert.equal(held.refCount, 2);
      assert.ok(held.compromiseTimer);
      let closes = 0;
      const close = held.handle.close.bind(held.handle);
      held.handle.close = async () => { closes++; await close(); };
      process.on("exit", () => console.log(JSON.stringify({
        closes, timerCleared: held.compromiseTimer === undefined,
      })));
    `);
    expect(JSON.parse(output)).toEqual({ closes: 1, timerCleared: true });
    await expectAbsent(directory);
  });

  it("manager reset still releases a retainOnExit raw lock", async () => {
    const directory = await tempRoot("fs-safe-lock-reset-retain-");
    const target = path.join(directory, "state.json");
    const manager = createFileLockManager("reset-retain");
    const lock = await manager.acquire(target, { payload: () => ({ owner: "caller" }), retainOnExit: true });
    expect(await lock.verifyStillHeld()).toBe(true);
    manager.reset();
    await expectAbsent(directory);
  });

  it("rejects retainOnExit when a legacy package copy owns the exit handlers", async () => {
    const globalWithCleanup = globalThis as Record<symbol, unknown>;
    const cleanupKey = Symbol.for("fsSafe.sidecarLockCleanupRegistered");
    const retainAwareKey = Symbol.for("fsSafe.sidecarLockRetainAwareCleanup");
    const priorCleanup = globalWithCleanup[cleanupKey];
    const priorRetainAware = globalWithCleanup[retainAwareKey];
    // Simulate a legacy copy that registered the exit handler without the
    // retain-aware marker; the new copy must fail closed, not silently lose it.
    globalWithCleanup[cleanupKey] = true;
    delete globalWithCleanup[retainAwareKey];
    try {
      const directory = await tempRoot("fs-safe-lock-legacy-retain-");
      const manager = createFileLockManager("legacy-retain");
      await expect(
        manager.acquire(path.join(directory, "state.json"), {
          payload: () => ({ owner: "caller" }),
          retainOnExit: true,
        }),
      ).rejects.toMatchObject({ code: "helper-unavailable" });
    } finally {
      if (priorCleanup === undefined) delete globalWithCleanup[cleanupKey];
      else globalWithCleanup[cleanupKey] = priorCleanup;
      if (priorRetainAware === undefined) delete globalWithCleanup[retainAwareKey];
      else globalWithCleanup[retainAwareKey] = priorRetainAware;
    }
  });

  it("joins an explicit release already in flight", async () => {
    const directory = await tempRoot("fs-safe-lock-exit-in-flight-");
    const output = await runChild(directory, `
      const lock = await acquireFileLock(targetPath, options);
      const remove = capability.remove.bind(capability);
      let removals = 0;
      let finish;
      capability.remove = async (...args) => {
        removals++;
        await new Promise(resolve => { finish = resolve; });
        return await remove(...args);
      };
      let released = false;
      void lock.release().then(() => { released = true; });
      process.once("beforeExit", () => {
        assert.equal(removals, 1);
        setImmediate(finish);
      });
      process.on("exit", () => console.log(JSON.stringify({ removals, released })));
    `);
    expect(JSON.parse(output)).toEqual({ removals: 1, released: true });
    await expectAbsent(directory);
  });

  describe("physical package copies", () => {
    let directory: string | undefined;
    const run = useSuiteFixture(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-lock-exit-copies-"));
      const copy = path.join(directory, "copy");
      await fs.mkdir(copy);
      await fs.copyFile(new URL("../package.json", import.meta.url), path.join(copy, "package.json"));
      await fs.cp(new URL("../dist", import.meta.url), path.join(copy, "dist"), { recursive: true });
      return directory;
    }, async () => {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    });

    it("deduplicates listeners across manager domains and physical package copies", () => run(async (directory) => {
      const output = await runChild(directory, `
        const { createRequire } = await import("node:module");
        const { pathToFileURL } = await import("node:url");
        const copyRequire = createRequire(path.join(directory, "copy", "package.json"));
        const other = await import(pathToFileURL(copyRequire.resolve("@openclaw/fs-safe/file-lock")));
        assert.notEqual(other.createFileLockManager, createFileLockManager);
        const before = process.listenerCount("beforeExit");
        for (let index = 0; index < 12; index++) {
          const api = index % 2 ? other : { createFileLockManager };
          await api.createFileLockManager("domain-" + index)
            .acquire(path.join(directory, index + ".json"), options);
        }
        console.log(process.listenerCount("beforeExit") - before);
      `);
      expect(output).toBe("1");
      for (let index = 0; index < 12; index++) await expectAbsent(directory, `${index}.json.lock`);
    }));
  });

  it("registers beforeExit when an older copy already registered exit cleanup", async () => {
    const directory = await tempRoot("fs-safe-lock-exit-legacy-");
    const output = await runChild(directory, `
      const oldExit = () => {};
      globalThis[Symbol.for("fsSafe.sidecarLockCleanupRegistered")] = true;
      globalThis[Symbol.for("fsSafe.sidecarLockCleanupHandler")] = oldExit;
      process.on("exit", oldExit);
      const before = process.listenerCount("beforeExit");
      const exits = process.listenerCount("exit");
      await acquireFileLock(targetPath, options);
      assert.equal(process.listenerCount("exit"), exits);
      assert.equal(globalThis[Symbol.for("fsSafe.sidecarLockCleanupHandler")], oldExit);
      console.log(process.listenerCount("beforeExit") - before);
    `);
    expect(output).toBe("1");
    await expectAbsent(directory);
  });

  it("re-arms after a completed cleanup cycle when another listener acquires", async () => {
    const directory = await tempRoot("fs-safe-lock-exit-rearm-");
    const output = await runChild(directory, `
      const manager = createFileLockManager("rearm");
      await manager.acquire(targetPath, options);
      let cycles = 0;
      let acquired = false;
      process.on("beforeExit", () => {
        cycles++;
        if (cycles !== 2) return;
        assert.equal(manager.heldEntries().length, 0);
        setImmediate(() => {
          void manager.acquire(targetPath, options).then(() => { acquired = true; });
        });
      });
      process.on("exit", () => console.log(JSON.stringify({ cycles, acquired })));
    `);
    expect(JSON.parse(output)).toEqual({ cycles: 4, acquired: true });
    await expectAbsent(directory);
  });
});
