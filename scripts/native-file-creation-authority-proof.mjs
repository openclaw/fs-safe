import assert from "node:assert/strict";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative, root } from "../dist/index.js";
import { getNativeBinding, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../dist/native.js";

configureFsSafeNative({ mode: "require" });
const native = getNativeBinding("openBeneath", "openCreateBeneath", "closeOwnedFd");
assert(native);
for (const scenario of ["append", "openWritable", "parent-before-open", "parent-before-create", "raced-file", "raced-symlink", "raced-hardlink"]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-create-authority-"));
  const directory = path.join(base, "root"), parent = path.join(directory, "parent");
  const held = path.join(directory, "held"), outside = path.join(base, "outside");
  const target = path.join(parent, "file"), seed = path.join(outside, "seed");
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(seed, "outside");
  const safe = await root(directory);
  const descriptors = [];
  const opened = fd => { descriptors.push({ fd, closed: false }); return fd; };
  const closed = fd => {
    const item = descriptors.findLast(value => value.fd === fd && !value.closed);
    if (item) item.closed = true;
  };
  let handles = 0, closedHandles = 0, injected = false;
  const originalOpenSync = fs.openSync, originalCloseSync = fs.closeSync, originalOpen = fsAsync.open;
  const replaceParent = () => {
    assert(!injected);
    injected = true;
    fs.renameSync(parent, held);
    fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
  };
  fs.openSync = (...args) => opened(originalOpenSync(...args));
  fs.closeSync = fd => { const result = originalCloseSync(fd); closed(fd); return result; };
  fsAsync.open = async (...args) => {
    const handle = await originalOpen(...args);
    handles++;
    const close = handle.close.bind(handle);
    let completed = false;
    handle.close = async () => {
      const result = await close();
      if (!completed) { completed = true; closedHandles++; }
      return result;
    };
    return handle;
  };
  __setNativeLoaderForTest(() => ({ ...native,
    openBeneath(...args) {
      if (scenario === "parent-before-open" && args[1] === "parent") replaceParent();
      const result = native.openBeneath(...args);
      opened(result.fd);
      return result;
    },
    openCreateBeneath(...args) {
      if (scenario === "parent-before-create") replaceParent();
      if (!injected && scenario.startsWith("raced-")) {
        injected = true;
        if (scenario === "raced-file") fs.writeFileSync(target, "raced");
        if (scenario === "raced-symlink") fs.symlinkSync(seed, target);
        if (scenario === "raced-hardlink") fs.linkSync(seed, target);
      }
      return opened(native.openCreateBeneath(...args));
    },
    closeOwnedFd(fd) { const result = native.closeOwnedFd(fd); closed(fd); return result; },
  }));
  let failure;
  try {
    if (scenario === "openWritable") {
      const value = await safe.openWritable("parent/file", { writeMode: "append" });
      try { await value.handle.writeFile("payload"); } finally { await value.handle.close(); }
    } else {
      await safe.append("parent/file", "payload", { durable: false });
    }
  } catch (error) { failure = error; }
  finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fsAsync.open = originalOpen;
    __resetNativeLoaderForTest();
  }
  try {
    assert(descriptors.length > 0);
    assert.equal(descriptors.filter(item => !item.closed).length, 0);
    assert.equal(handles, closedHandles);
    assert.equal(fs.readFileSync(seed, "utf8"), "outside");
    assert.deepEqual(fs.readdirSync(outside), ["seed"]);
    if (["append", "openWritable", "raced-file"].includes(scenario)) {
      assert.equal(failure, undefined);
      assert.equal(fs.readFileSync(target, "utf8"), scenario === "raced-file" ? "racedpayload" : "payload");
    } else {
      assert(injected);
      assert(failure instanceof Error);
      if (scenario.startsWith("parent-")) assert.deepEqual(fs.readdirSync(held), []);
    }
    console.log(JSON.stringify({ platform: process.platform, scenario, outcome: failure ? "rejected" : "written",
      error: failure?.code, outsideUnchanged: true, descriptors: descriptors.length,
      closedDescriptors: descriptors.filter(item => item.closed).length, handles, closedHandles }));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}
