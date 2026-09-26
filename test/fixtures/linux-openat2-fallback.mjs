import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { root } from "../../dist/root.js";
import { tempWorkspace } from "../../dist/temp.js";
import { __setNativeLoaderForTest } from "../../dist/native.js";

const native = createRequire(import.meta.url)(process.argv[2]);
// Use this same addon instance for Root dispatch, even after clearing the hook.
__setNativeLoaderForTest(() => native);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-openat2-fallback-"));
let rootFd;
try {
  const base = path.join(fixture, "root");
  fs.mkdirSync(base, { mode: 0o700 });
  fs.mkdirSync(path.join(base, "incoming/deep"), { recursive: true });
  fs.mkdirSync(path.join(base, "archive/deep"), { recursive: true });
  fs.writeFileSync(path.join(base, "incoming/deep/source"), "source");
  fs.writeFileSync(path.join(fixture, "outside"), "keep outside");
  rootFd = fs.openSync(base, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  for (let attempt = 0; attempt < 3; attempt++) {
    const opened = native.openBeneath(rootFd, "incoming/deep/source", fs.constants.O_RDONLY);
    try {
      assert.equal(opened.containment, "best-effort");
      assert.equal(fs.readFileSync(opened.fd, "utf8"), "source");
      assert.equal(fs.fstatSync(opened.fd).ino, fs.statSync(path.join(base, "incoming/deep/source")).ino);
    } finally { native.closeOwnedFd(opened.fd); }
    // Capability selection survives later environment changes in this process.
    delete process.env.FS_SAFE_TEST_NO_OPENAT2;
  }
  for (const name of ["../outside", "/outside", "incoming/../../outside"]) {
    assert.throws(() => native.openBeneath(rootFd, name, fs.constants.O_RDONLY), { code: "EINVAL" });
  }
  for (const fd of [-1, -100]) {
    assert.throws(() => native.openBeneath(fd, "incoming", fs.constants.O_RDONLY), { code: "EBADF" });
  }
  const pathRoot = fs.openSync(base, 0x200000 | fs.constants.O_DIRECTORY); // Linux O_PATH.
  try {
    for (const name of [".", "./", "./."]) {
      assert.throws(() => native.openBeneath(pathRoot, name, fs.constants.O_WRONLY), { code: "EISDIR" });
      const opened = native.openBeneath(pathRoot, name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        // fsync rejects an O_PATH descriptor: this must be a new readable open.
        fs.fsyncSync(opened.fd);
      } finally { native.closeOwnedFd(opened.fd); }
    }
  } finally { fs.closeSync(pathRoot); }
  for (const name of [".", "./.", "incoming"]) {
    assert.throws(() => native.openBeneath(rootFd, name, 0x410000 | fs.constants.O_RDWR), { code: "ENOTSUP" });
  }
  for (const name of ["missing/", "missing/.", "incoming/missing/", "incoming/missing/."]) {
    assert.throws(() => native.openBeneath(rootFd, name, fs.constants.O_CREAT | fs.constants.O_WRONLY), { code: "EINVAL" });
    assert.equal(fs.existsSync(path.join(base, name.replace(/\/(?:\.)?$/, ""))), false);
  }
  assert.throws(() => native.openBeneath(rootFd, "missing", fs.constants.O_CREAT | fs.constants.O_DIRECTORY | fs.constants.O_WRONLY), { code: "EINVAL" });
  assert.equal(fs.existsSync(path.join(base, "missing")), false);
  fs.symlinkSync("../outside", path.join(base, "escape"));
  fs.symlinkSync("incoming", path.join(base, "alias"));
  fs.symlinkSync(`/proc/self/fd/${rootFd}`, path.join(base, "magic"));
  for (const name of ["escape", "alias/deep/source", "magic/incoming/deep/source"]) {
    assert.throws(() => native.openBeneath(rootFd, name, fs.constants.O_RDONLY), { code: "ELOOP" });
  }
  // O_PATH | O_NOFOLLOW must also refuse a symlink descriptor.
  assert.throws(() => native.openBeneath(rootFd, "escape", 0x200000 | fs.constants.O_NOFOLLOW), { code: "ELOOP" });
  assert.throws(() => native.openBeneath(rootFd, "incoming/deep/source/", fs.constants.O_RDONLY), { code: "ENOTDIR" });

  const scoped = await root(base);
  await scoped.move("incoming/deep/source", "archive/deep/target");
  assert.equal(fs.existsSync(path.join(base, "incoming/deep/source")), false);
  assert.equal(fs.readFileSync(path.join(base, "archive/deep/target"), "utf8"), "source");
  fs.writeFileSync(path.join(base, "incoming/deep/source"), "competitor source");
  await assert.rejects(scoped.move("incoming/deep/source", "archive/deep/target"), { code: "already-exists" });
  assert.equal(fs.readFileSync(path.join(base, "incoming/deep/source"), "utf8"), "competitor source");
  assert.equal(fs.readFileSync(path.join(base, "archive/deep/target"), "utf8"), "source");
  await scoped.write("archive/deep/written", "new contents");
  assert.equal(await scoped.readText("archive/deep/written"), "new contents");
  fs.linkSync(path.join(base, "archive/deep/written"), path.join(base, "hardlink"));
  await assert.rejects(scoped.readText("hardlink", { hardlinks: "reject" }), { code: "hardlink" });
  assert.equal(fs.readFileSync(path.join(fixture, "outside"), "utf8"), "keep outside");

  assert.equal(native.ownedTreeRemovalAvailable(rootFd), false);
  await assert.rejects(tempWorkspace({ rootDir: base, prefix: "bounded-", cleanupSafety: "require-bounded" }), { code: "helper-unavailable" });
  console.log("openat2 fallback: passed (nested move, collision, read/write, symlink/traversal/hardlink rejection, bounded-cleanup refusal, cached selection)");
} finally {
  if (rootFd !== undefined) fs.closeSync(rootFd);
  fs.rmSync(fixture, { recursive: true, force: true });
}
