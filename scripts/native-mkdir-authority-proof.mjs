import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative, FsSafeError, root } from "../dist/index.js";
import { getNativeBinding, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../dist/native.js";

configureFsSafeNative({ mode: "require" });
const native = getNativeBinding("openBeneath", "mkdirChildBeneath", "closeOwnedFd");
assert(native);
for (const scenario of ["allowed", "parent-before-open", "parent-before-mutation", "file-collision"]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-mkdir-authority-"));
  const directory = path.join(base, "root");
  const parent = path.join(directory, "parent");
  const held = path.join(directory, "held");
  const outside = path.join(base, "outside");
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(outside);
  const safe = await root(directory);
  const owners = [];
  const opened = fd => { owners.push({ fd, closed: false }); return fd; };
  const closed = fd => {
    const owner = owners.findLast(item => item.fd === fd && !item.closed);
    if (owner) owner.closed = true;
  };
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let injected = false;
  const replaceParent = () => {
    assert(!injected);
    injected = true;
    fs.renameSync(parent, held);
    fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
  };
  const beforeMutation = () => {
    if (scenario === "parent-before-mutation") replaceParent();
    if (scenario === "file-collision") {
      assert(!injected);
      injected = true;
      fs.writeFileSync(path.join(parent, "child"), "raced file");
    }
  };
  fs.openSync = (...args) => opened(originalOpen(...args));
  fs.closeSync = fd => { const result = originalClose(fd); closed(fd); return result; };
  __setNativeLoaderForTest(() => ({ ...native,
    openBeneath(...args) {
      if (scenario === "parent-before-open" && args[1] === "parent") replaceParent();
      const result = native.openBeneath(...args);
      opened(result.fd);
      return result;
    },
    closeOwnedFd(fd) { const result = native.closeOwnedFd(fd); closed(fd); return result; },
    ...(native.mkdirOpenChildBeneath ? { mkdirOpenChildBeneath(...args) {
      beforeMutation();
      const result = native.mkdirOpenChildBeneath(...args);
      opened(result.fd);
      return result;
    } } : { mkdirChildBeneath(...args) {
      beforeMutation();
      return native.mkdirChildBeneath(...args);
    } }),
  }));
  let failure;
  try {
    await safe.mkdir("parent/child");
  } catch (error) { failure = error; }
  finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    __resetNativeLoaderForTest();
  }
  try {
    assert.equal(owners.filter(item => !item.closed).length, 0, "every returned/Node descriptor closes");
    assert.deepEqual(fs.readdirSync(outside), []);
    if (scenario === "allowed") {
      assert.equal(failure, undefined);
      assert(fs.statSync(path.join(parent, "child")).isDirectory());
    } else {
      assert(injected);
      assert(failure instanceof Error);
    }
    if (scenario === "parent-before-open") assert.deepEqual(fs.readdirSync(held), []);
    if (scenario === "parent-before-mutation") assert(fs.statSync(path.join(held, "child")).isDirectory());
    if (scenario === "file-collision") {
      assert(failure instanceof FsSafeError);
      assert.equal(failure.code, "not-file");
      if (failure.cause !== undefined || process.platform !== "win32") assert.equal(failure.cause?.code, "ENOTDIR");
      assert.equal(fs.readFileSync(path.join(parent, "child"), "utf8"), "raced file");
    }
    console.log(JSON.stringify({ platform: process.platform, forcedOpenat: process.env.FS_SAFE_TEST_NO_OPENAT2 === "1",
      scenario, outcome: failure ? "rejected" : "created", error: failure?.code, cause: failure?.cause?.code,
      outsideEntries: [], retainedChild: scenario === "parent-before-mutation", opened: owners.length,
      closed: owners.filter(item => item.closed).length }));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

if (native.mkdirOpenChildBeneath) {
  for (const scenario of ["chain-allowed", "chain-root-before-create", "chain-parent-before-open",
    "chain-ancestor-before-create", "chain-child-after-open", "chain-file-collision"]) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-mkdir-chain-"));
    const directory = path.join(base, "root");
    const outside = path.join(base, "outside");
    const parent = path.join(directory, "parent");
    const prefixed = scenario === "chain-parent-before-open";
    fs.mkdirSync(directory);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel"), "unchanged");
    if (prefixed) fs.mkdirSync(parent);
    const safe = await root(directory);
    const owners = [];
    const creates = [];
    const opened = fd => { owners.push({ fd, closed: false }); return fd; };
    const closed = fd => {
      const owner = owners.findLast(item => item.fd === fd && !item.closed);
      assert(owner, "only a recorded owned descriptor may close");
      owner.closed = true;
    };
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let injected = false;
    const replace = pathname => {
      assert(!injected);
      injected = true;
      fs.renameSync(pathname, `${pathname}-held`);
      fs.symlinkSync(outside, pathname, process.platform === "win32" ? "junction" : "dir");
    };
    fs.openSync = (...args) => opened(originalOpen(...args));
    fs.closeSync = fd => { const result = originalClose(fd); closed(fd); return result; };
    __setNativeLoaderForTest(() => ({ ...native,
      openBeneath(...args) {
        if (prefixed && args[1] === "parent") replace(parent);
        const result = native.openBeneath(...args);
        opened(result.fd);
        return result;
      },
      mkdirOpenChildBeneath(...args) {
        creates.push(args[1]);
        if (scenario === "chain-root-before-create" && args[1] === "a") replace(directory);
        if (scenario === "chain-ancestor-before-create" && args[1] === "b") replace(path.join(directory, "a"));
        if (scenario === "chain-file-collision" && args[1] === "b") {
          injected = true;
          fs.writeFileSync(path.join(directory, "a/b"), "raced file");
        }
        const result = native.mkdirOpenChildBeneath(...args);
        opened(result.fd);
        if (scenario === "chain-child-after-open" && args[1] === "b") replace(path.join(directory, "a/b"));
        return result;
      },
      closeOwnedFd(fd) { const result = native.closeOwnedFd(fd); closed(fd); return result; },
    }));
    let failure;
    try { await safe.mkdir(prefixed ? "parent/a/b/c" : "a/b/c"); }
    catch (error) { failure = error; }
    finally {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
      __resetNativeLoaderForTest();
    }
    try {
      assert.equal(owners.filter(item => !item.closed).length, 0, "all chain descriptors settle");
      assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
      assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "unchanged");
      if (scenario === "chain-allowed") {
        assert.equal(failure, undefined);
        assert.deepEqual(creates, ["a", "b", "c"]);
        assert(fs.statSync(path.join(directory, "a/b/c")).isDirectory());
      } else {
        assert(injected);
        assert(failure instanceof Error);
        assert(!creates.includes("c"), "a rejected chain must not attempt its final component");
      }
      if (scenario === "chain-root-before-create") {
        assert.deepEqual(creates, ["a"]);
        assert.deepEqual(fs.readdirSync(`${directory}-held`), ["a"]);
        assert.deepEqual(fs.readdirSync(path.join(`${directory}-held`, "a")), []);
      }
      if (prefixed) {
        assert.deepEqual(creates, []);
        assert.deepEqual(fs.readdirSync(`${parent}-held`), []);
      }
      if (scenario === "chain-ancestor-before-create") {
        assert.deepEqual(creates, ["a", "b"]);
        assert.deepEqual(fs.readdirSync(path.join(directory, "a-held")), ["b"]);
        assert.deepEqual(fs.readdirSync(path.join(directory, "a-held/b")), []);
      }
      if (scenario === "chain-child-after-open") {
        assert.deepEqual(creates, ["a", "b"]);
        assert.deepEqual(fs.readdirSync(path.join(directory, "a/b-held")), []);
      }
      if (scenario === "chain-file-collision") {
        assert.equal(failure?.code, "not-file");
        assert.equal(fs.readFileSync(path.join(directory, "a/b"), "utf8"), "raced file");
      }
      console.log(JSON.stringify({ platform: process.platform,
        forcedOpenat: process.env.FS_SAFE_TEST_NO_OPENAT2 === "1", scenario,
        entryPoint: prefixed ? "Root.mkdir(parent/a/b/c)" : "Root.mkdir(a/b/c)",
        outcome: failure ? "rejected" : "created", error: failure?.code,
        creates, outsideEntries: ["sentinel"], outsideContents: "unchanged",
        laterCreationStopped: scenario === "chain-allowed" ? null : !creates.includes("c"),
        opened: owners.length, closed: owners.filter(item => item.closed).length }));
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
}
