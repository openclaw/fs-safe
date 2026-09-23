const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const native = require(process.argv[2]);
const method = process.argv[3];
assert.equal(typeof native[method], "function", `${method} must be available`);
const initialCwd = process.cwd();
const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fs-safe-fd-admission-"));
const parent = path.join(fixture, "parent");
const cwd = path.join(fixture, "cwd");
const descriptors = new Set();
const payload = Buffer.from("payload");

function open(name, flags = fs.constants.O_RDONLY) {
  const fd = fs.openSync(name, flags);
  descriptors.add(fd);
  return fd;
}

function error(code, operation) {
  return value => {
    assert.equal(value.code, code);
    if (operation) assert.ok(value.message.startsWith(`${operation}: `), value.message);
    return true;
  };
}

async function invoke(...args) {
  const result = await native[method](...args);
  if (result?.errorCode) {
    throw Object.assign(new Error(result.errorMessage), { code: result.errorCode });
  }
  return result;
}

async function rejects(args, code = "EBADF", operation) {
  await assert.rejects(() => invoke(...args), error(code, operation));
}

async function run() {
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  fs.mkdirSync(path.join(parent, "owned"));
  fs.mkdirSync(path.join(cwd, "owned"));
  fs.writeFileSync(path.join(parent, "source"), payload, { mode: 0o600 });
  fs.writeFileSync(path.join(parent, "target"), "original target tail", { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, "stage"), "cwd stage", { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, "sentinel"), "keep cwd bytes", { mode: 0o600 });
  const root = open(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const source = open(path.join(parent, "source"));
  const target = open(path.join(parent, "target"), fs.constants.O_RDWR);
  const directory = open(path.join(parent, "owned"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const cwdFile = open(path.join(cwd, "stage"));
  const cwdDirectory = open(path.join(cwd, "owned"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const identities = new Map([...descriptors].map(fd => [fd, fs.fstatSync(fd, { bigint: true })]));
  const prefix = Buffer.alloc(2);
  fs.readSync(source, prefix, 0, prefix.length, null);
  assert.equal(prefix.toString(), "pa");
  const invalids = [-1, -2, -100, -2147483648];
  process.chdir(cwd);

  switch (method) {
    case "fstatIdentity":
    case "probeTreeClone": {
      const operation = method === "fstatIdentity" ? "fstat" : "inspect clone filesystem";
      if (method === "fstatIdentity") assert.equal((await invoke(root)).isDirectory, true);
      else await invoke(root);
      for (const fd of invalids) await rejects([fd], "EBADF", operation);
      await invoke(root);
      break;
    }
    case "mkdirChildBeneath": {
      for (const fd of invalids) await rejects([fd, "created", 0o700], "EBADF", "mkdirat direct child");
      await rejects([-1, "../invalid", 0o700], "EINVAL");
      assert.equal(await invoke(root, "created", 0o700), true);
      assert.equal(await invoke(root, "created", 0o700), false);
      assert.equal(fs.existsSync(path.join(cwd, "created")), false);
      break;
    }
    case "createStagedFile": {
      for (const fd of invalids) await rejects([fd, "created"], "EBADF", "create staged child");
      await rejects([-1, "../invalid"], "EINVAL");
      const fd = await invoke(root, "created");
      assert.equal(fs.fstatSync(fd).isFile(), true);
      native.closeOwnedFd(fd);
      assert.equal(fs.existsSync(path.join(cwd, "created")), false);
      break;
    }
    case "stagedFileMatches":
    case "removeStagedFile": {
      for (const fd of invalids) {
        await rejects([root, "source", fd], "EBADF", "inspect staged descriptor");
        await rejects([fd, "stage", cwdFile], "EBADF", "inspect staged child");
      }
      await rejects([-1, "stage", -2], "EBADF", "inspect staged descriptor");
      await rejects([-1, "../invalid", -1], "EINVAL");
      assert.equal(fs.readFileSync(path.join(cwd, "stage"), "utf8"), "cwd stage");
      if (method === "stagedFileMatches") {
        assert.equal(await invoke(root, "source", source), true);
        assert.equal(await invoke(root, "target", source), false);
      } else {
        assert.equal(await invoke(root, "target", source), "preserved");
        const stage = native.createStagedFile(root, "cleanup");
        try {
          assert.equal(await invoke(root, "cleanup", stage), "removed");
          assert.equal(await invoke(root, "cleanup", stage), "name-absent");
        } finally { native.closeOwnedFd(stage); }
      }
      break;
    }
    case "removeOwnedTree":
    case "removeOwnedTreeSync": {
      for (const fd of invalids) {
        await rejects([root, "owned", fd], "EBADF", "inspect owned directory descriptor");
        await rejects([fd, "owned", cwdDirectory], "EBADF", "inspect owned directory name");
      }
      await rejects([-1, "owned", -2], "EBADF", "inspect owned directory descriptor");
      await rejects([-1, "../invalid", -1], method.endsWith("Sync") ? "EINVAL" : "InvalidArg");
      assert.equal(fs.statSync(path.join(cwd, "owned")).isDirectory(), true);
      assert.equal((await invoke(root, "owned", cwdDirectory)).outcome, "preserved");
      assert.equal((await invoke(root, "owned", directory)).outcome, "removed");
      break;
    }
    case "sha256File": {
      for (const fd of invalids) await rejects([fd], "EBADF", "read file at offset");
      await rejects([-1, -1], "InvalidArg");
      assert.deepEqual(await invoke(source), {
        bytes: payload.length, digest: createHash("sha256").update(payload).digest("hex"),
      });
      break;
    }
    case "cloneFileExclusive": {
      await rejects([-1, -1, "../invalid"], "EINVAL");
      for (const fd of invalids) {
        await rejects([source, fd, "cloned"], "EBADF");
        await rejects([fd, root, "cloned"], "EBADF", process.platform === "linux" ? "FICLONE" : "inspect clone source");
        assert.equal(fs.existsSync(path.join(parent, "cloned")), false);
      }
      if (process.platform === "linux") {
        await rejects([-1, root, "target"], "EEXIST");
      } else {
        await rejects([-1, -1, "cloned"], "EBADF", "inspect descriptor security facts");
      }
      try {
        const cloned = await invoke(source, root, "cloned");
        native.closeOwnedFd(cloned);
        assert.deepEqual(fs.readFileSync(path.join(parent, "cloned")), payload);
      } catch (failure) {
        assert.ok(["ENOTSUP", "ENOSYS", "EXDEV"].includes(failure.code), failure.message);
      }
      break;
    }
    case "copyFileRangeExclusive": {
      for (const fd of invalids) await rejects([fd, root, "copied"], "EBADF", "inspect copy source");
      await rejects([-2, -1, "copied"], "EBADF", "inspect copy source");
      await rejects([-1, -1, "../invalid"], "InvalidArg");
      assert.equal(fs.existsSync(path.join(parent, "copied")), false);
      try {
        const copied = await invoke(source, root, "copied");
        native.closeOwnedFd(copied.fd);
        assert.deepEqual(fs.readFileSync(path.join(parent, "copied")), payload);
      } catch (failure) { assert.equal(failure.code, "ENOTSUP"); }
      break;
    }
    case "copyFileContents": {
      for (const fd of invalids) {
        await rejects([fd, target], "EBADF", "inspect copy source");
        await rejects([source, fd], "EBADF", "inspect copy target");
      }
      await rejects([-2, -1], "EBADF", "inspect copy source");
      assert.equal(fs.readFileSync(path.join(parent, "target"), "utf8"), "original target tail");
      await invoke(source, target);
      assert.equal(fs.readFileSync(path.join(parent, "target"), "utf8"), "payloadl target tail");
      break;
    }
    case "cloneTree": {
      for (const fd of invalids) {
        await rejects([undefined, fd, "tree", 1], "EBADF", "inspect clone filesystem");
        await rejects([directory, fd, "tree", 1], "EBADF", "inspect clone filesystem");
      }
      const supported = native.probeTreeClone(root);
      for (const fd of invalids) {
        await rejects([fd, root, "tree", 1], supported ? "EBADF" : "CLONE_UNAVAILABLE",
          supported ? "inspect clone filesystem" : undefined);
      }
      await rejects([-1, -1, "../invalid", 1], "InvalidArg");
      await rejects([-1, -1, "tree", 0], "InvalidArg");
      assert.equal(fs.existsSync(path.join(parent, "tree")), false);
      assert.equal(fs.existsSync(path.join(cwd, "tree")), false);
      break;
    }
    case "openBeneath": {
      const create = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
      const truncate = fs.constants.O_WRONLY | fs.constants.O_TRUNC;
      for (const fd of invalids) {
        await rejects([fd, "created", create]);
        await rejects([fd, "sentinel", truncate]);
      }
      await rejects([-1, "../invalid", create], "EINVAL");
      assert.equal(fs.existsSync(path.join(cwd, "created")), false);
      assert.equal(fs.readFileSync(path.join(cwd, "sentinel"), "utf8"), "keep cwd bytes");
      const opened = await invoke(root, "source", fs.constants.O_RDONLY);
      assert.equal(fs.fstatSync(opened.fd).size, payload.length);
      native.closeOwnedFd(opened.fd);
      // Existing no-op recursive mkdir remains independent of a descriptor.
      native.mkdirBeneath(-1, ".", 0o700);
      native.mkdirBeneath(-1, "", 0o700);
      break;
    }
    case "extractArchiveNative": {
      const { c: createTar } = require("tar");
      const archive = path.join(fixture, "source.tar");
      await createTar({ cwd: parent, file: archive }, ["source"]);
      const limits = { maxEntries: 10, maxMetaEntryBytes: 4096, maxDecodedBytes: 16384, maxManifestBytes: 16384 };
      const plan = [{ index: 0, path: "extracted", kind: "file", size: payload.length, mode: 0o600 }];
      for (const fd of invalids) {
        await assert.rejects(() => invoke(archive, "tar", fd, plan, limits, new AbortController().signal),
          failure => { assert.match(failure.message, /[Bb]ad file descriptor/); return true; });
        assert.equal(fs.existsSync(path.join(cwd, "extracted")), false);
      }
      await rejects([archive, "tar", -1, [{ ...plan[0], path: "../invalid" }], limits, new AbortController().signal], "InvalidArg");
      await invoke(archive, "tar", -1, [], limits, new AbortController().signal);
      await invoke(archive, "tar", root, plan, limits, new AbortController().signal);
      assert.deepEqual(fs.readFileSync(path.join(parent, "extracted")), payload);
      break;
    }
    default: assert.fail(`Unknown descriptor admission case: ${method}`);
  }

  for (const [fd, before] of identities) {
    const after = fs.fstatSync(fd, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
  }
  const next = Buffer.alloc(1);
  fs.readSync(source, next, 0, 1, null);
  assert.equal(next.toString(), "y");
  assert.deepEqual(fs.readFileSync(path.join(parent, "source")), payload);
  assert.equal(fs.readFileSync(path.join(cwd, "sentinel"), "utf8"), "keep cwd bytes");
}

run().then(() => {
  process.stdout.write(`${method}: passed\n`);
}).catch(failure => {
  console.error(failure);
  process.exitCode = 1;
}).finally(() => {
  process.chdir(initialCwd);
  for (const fd of descriptors) fs.closeSync(fd);
  fs.rmSync(fixture, { recursive: true, force: true });
});
