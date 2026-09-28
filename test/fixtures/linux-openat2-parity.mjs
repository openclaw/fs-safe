import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { root } from "../../dist/root.js";
import { __setNativeLoaderForTest } from "../../dist/native.js";
import { __setFsSafeTestHooksForTest } from "../../dist/test-hooks.js";

const native = createRequire(import.meta.url)(process.argv[2]);
__setNativeLoaderForTest(() => native);
const base = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-beneath-parity-"));
const results = {};
const fd = fs.openSync(base, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
async function record(name, operation, expected = "ok") {
  let outcome;
  try { outcome = await operation() ?? "ok"; }
  catch (error) { outcome = error.code; }
  assert.equal(outcome, expected, name);
  results[name] = outcome;
}
try {
  fs.mkdirSync(path.join(base, "actual"));
  fs.symlinkSync("actual", path.join(base, "alias"));
  fs.symlinkSync("alias", path.join(base, "chain"));
  fs.symlinkSync("../actual", path.join(base, "actual/up"));
  const probe = native.openBeneath(fd, "actual", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const containment = probe.containment;
  native.closeOwnedFd(probe.fd);
  const safe = await root(base, { symlinks: "follow-within-root" });
  await record("create", async () => { await safe.create("alias/file", "first"); });
  await record("write", async () => { await safe.write("chain/file", "second"); });
  await record("read", () => safe.readText("actual/up/file"), "second");
  await record("move", async () => { await safe.move("alias/file", "chain/moved"); });
  await record("mkdir", async () => { await safe.mkdir("alias/sub"); });
  await record("remove", async () => { await safe.remove("chain/moved"); });
  assert.equal(fs.existsSync(path.join(base, "actual/moved")), false);
  assert.equal(fs.statSync(path.join(base, "actual/sub")).isDirectory(), true);

  function nativeOpen(name, flags) {
    const opened = native.openBeneath(fd, name, flags);
    native.closeOwnedFd(opened.fd);
  }
  fs.symlinkSync("actual/new", path.join(base, "dangling"));
  await record("dangling-create", () => nativeOpen("dangling", fs.constants.O_CREAT | fs.constants.O_WRONLY));
  assert.equal(fs.statSync(path.join(base, "actual/new")).isFile(), true);
  await record("nofollow-read", () => nativeOpen("alias", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), "ELOOP");
  await record("nofollow-path", () => {
    const opened = native.openBeneath(fd, "alias", 0x200000 | fs.constants.O_NOFOLLOW);
    try { assert.equal(fs.fstatSync(opened.fd).isSymbolicLink(), true); }
    finally { native.closeOwnedFd(opened.fd); }
  });
  await record("exclusive-link", () => nativeOpen("dangling", fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY), "EEXIST");
  fs.symlinkSync("../outside", path.join(base, "escape"));
  fs.symlinkSync(path.join(base, "actual"), path.join(base, "absolute"));
  fs.symlinkSync("loop", path.join(base, "loop"));
  for (const [name, expected] of [["escape", "EXDEV"], ["absolute", "EXDEV"], ["loop", "ELOOP"]]) {
    await record(name, () => nativeOpen(name, fs.constants.O_RDONLY), expected);
  }

  // Repeat the complete-parent and missing-parent post-preflight redirects
  // with the same frozen policy rules as the mutation admission regressions.
  for (const operation of ["write", "create", "copyIn"]) {
    for (const mkdir of [true, false]) {
      for (const policy of ["deny", "reject-symlink"]) {
        const label = `${operation}-${mkdir}-${policy}`;
        const caseDir = path.join(base, label);
        fs.mkdirSync(path.join(caseDir, "allowed"), { recursive: true });
        fs.mkdirSync(path.join(caseDir, "redirected"));
        if (!mkdir) {
          fs.mkdirSync(path.join(caseDir, "allowed/nested"));
          fs.mkdirSync(path.join(caseDir, "redirected/nested"));
        }
        const source = path.join(caseDir, "source");
        fs.writeFileSync(source, "payload");
        const scoped = await root(caseDir);
        let swapped = false;
        __setFsSafeTestHooksForTest({
          beforePinnedWriteParentAdmission() {
            if (swapped) return;
            swapped = true;
            fs.renameSync(path.join(caseDir, "allowed"), path.join(caseDir, "saved"));
            fs.symlinkSync("redirected", path.join(caseDir, "allowed"));
          },
        });
        const options = { mkdir, durable: false, ...(policy === "deny"
          ? { denyMutations: { prefixes: [path.join(caseDir, "redirected")] } }
          : { mutationSymlinks: "reject" }) };
        await record(label, async () => {
          if (operation === "copyIn") await scoped.copyIn("allowed/nested/value", source, options);
          else await scoped[operation]("allowed/nested/value", "payload", options);
        }, policy === "deny" ? "denied-path" : "symlink");
        assert.equal(swapped, true);
        assert.equal(fs.existsSync(path.join(caseDir, "redirected/nested/value")), false);
        if (mkdir) assert.equal(fs.existsSync(path.join(caseDir, "redirected/nested")), false);
        __setFsSafeTestHooksForTest();
      }
    }
  }
  for (const position of ["final-parent", "ancestor"]) {
    for (const mkdir of [true, false]) {
      for (const policy of ["deny", "reject-symlink"]) {
        const label = `complete-${position}-${mkdir}-${policy}`;
        const caseDir = path.join(base, label);
        for (const name of ["allowed", "redirected"]) {
          fs.mkdirSync(path.join(caseDir, name, ...(position === "ancestor" ? ["nested"] : [])), { recursive: true });
        }
        const scoped = await root(caseDir);
        let swapped = false;
        __setFsSafeTestHooksForTest({ beforePinnedWriteParentAdmission() {
          if (swapped) return;
          swapped = true;
          fs.renameSync(path.join(caseDir, "allowed"), path.join(caseDir, "saved"));
          fs.symlinkSync("redirected", path.join(caseDir, "allowed"));
        } });
        const relative = position === "ancestor" ? "allowed/nested/value" : "allowed/value";
        const options = { mkdir, durable: false, ...(policy === "deny"
          ? { denyMutations: { prefixes: [path.join(caseDir, "redirected")] } }
          : { mutationSymlinks: "reject" }) };
        await record(label, async () => { await scoped.write(relative, "payload", options); },
          policy === "deny" ? "denied-path" : "symlink");
        assert.equal(swapped, true);
        assert.equal(fs.existsSync(path.join(caseDir, relative.replace("allowed", "redirected"))), false);
        __setFsSafeTestHooksForTest();
      }
    }
  }
  console.log(JSON.stringify({ containment, results }));
} finally {
  __setFsSafeTestHooksForTest();
  fs.closeSync(fd);
  fs.rmSync(base, { recursive: true, force: true });
}
