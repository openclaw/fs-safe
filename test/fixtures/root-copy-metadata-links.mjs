import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { root } from "../../dist/root.js";
import { configureFsSafeNative } from "../../dist/config.js";
import { probeTreeClone } from "../../dist/copy.js";
import { getNativeBinding } from "../../dist/native.js";

const mode = isMainThread ? process.argv[2] ?? "auto" : workerData.mode;
const expectMissing = isMainThread ? process.argv[3] === "expect-missing" : workerData.expectMissing;
configureFsSafeNative({ mode });
const native = getNativeBinding();
if (expectMissing) assert.equal(native, undefined, "JavaScript-only fixture must not load an addon");
const nativeLinks = process.platform === "win32"
  ? Boolean(native?.copyLinkExclusive && native.publishCopyLink && native.removeCopyLink)
  : Boolean(native?.createCopySymlink);
const nativeMetadata = process.platform === "win32"
  ? Boolean(native?.readCopyMetadata && native.restoreCopyMetadata)
  : Boolean(native?.restoreCopyFileTimes);
if (mode === "require") assert.ok(nativeLinks, "required native link capability must be present");
if (mode === "require") assert.ok(nativeMetadata, "required native metadata capability must be present");
const canCopyLinks = process.platform === "linux" || nativeLinks;
function attributes(file, set) {
  const script = set === undefined
    ? '[int][IO.File]::GetAttributes($env:FS_SAFE_ATTRIBUTE_FILE)'
    : `[IO.File]::SetAttributes($env:FS_SAFE_ATTRIBUTE_FILE, [IO.FileAttributes]${set})`;
  return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", env: { ...process.env, FS_SAFE_ATTRIBUTE_FILE: file },
  }).trim());
}
async function prove(base, filesystem) {
  if (filesystem === "refs") assert.equal(probeTreeClone(base), "refs");
  if (filesystem === "ntfs") {
    const format = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      '([IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:FS_SAFE_ATTRIBUTE_FILE))).DriveFormat'], {
      encoding: "utf8", env: { ...process.env, FS_SAFE_ATTRIBUTE_FILE: base },
    }).trim();
    assert.equal(format, "NTFS");
  }
  const directory = fs.mkdtempSync(path.join(base, "copy-metadata-"));
  let cases = 0;
  try {
    const source = path.join(directory, "source");
    const targetDir = path.join(directory, "target");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(source, Buffer.alloc(128 * 1024 + 7, 0x67));
    const target = await root(targetDir);
    const atime = new Date("2001-02-03T04:05:06.000Z");
    const mtime = new Date("2002-03-04T05:06:07.000Z");
    if (process.platform === "win32") {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        '[IO.File]::SetCreationTimeUtc($env:FS_SAFE_ATTRIBUTE_FILE, [DateTime]::new(2000,1,2,3,4,5,[DateTimeKind]::Utc))'], {
        env: { ...process.env, FS_SAFE_ATTRIBUTE_FILE: source },
      });
      attributes(source, 0x3127);
    }
    else fs.chmodSync(source, 0o451);
    const before = fs.statSync(source);
    for (const clone of filesystem === "refs" ? ["never", "auto", "always"] : ["never", "auto"]) {
      fs.utimesSync(source, atime, mtime);
      const output = `metadata-${clone}`;
      await target.copyIn(output, source, { preserveMetadata: true, preserveSourceMode: true, clone, overwrite: false,
        onDestinationPublished(receipt) {
          assert.ok(Math.abs(fs.statSync(receipt.path).mtimeMs - mtime.getTime()) <= 1, "metadata precedes publication observer");
        },
      });
      const copied = fs.statSync(path.join(targetDir, output));
      assert.ok(Math.abs(copied.atimeMs - atime.getTime()) <= 1, `atime ${clone}`);
      assert.ok(Math.abs(copied.mtimeMs - mtime.getTime()) <= 1, `mtime ${clone}`);
      if (process.platform === "win32") {
        if (nativeMetadata) {
          assert.ok(Math.abs(copied.birthtimeMs - before.birthtimeMs) <= 1, `creation time ${clone}`);
          assert.equal(attributes(path.join(targetDir, output)) & 0x3127, 0x3127);
        } else {
          assert.ok(Math.abs(copied.birthtimeMs - before.birthtimeMs) > 60_000, "fallback cannot restore creation time");
          assert.equal(attributes(path.join(targetDir, output)) & 0x3106, 0, "fallback cannot restore native-only attributes");
        }
      } else assert.equal(copied.mode & 0o777, 0o451);
      assert.equal(fs.readFileSync(path.join(targetDir, output)).length, 128 * 1024 + 7);
      cases++;
    }
    fs.utimesSync(source, atime, mtime);
    await target.copyIn("explicit-mode", source, { preserveMetadata: true, preserveSourceMode: true, mode: 0o600 });
    const explicit = fs.statSync(path.join(targetDir, "explicit-mode"));
    assert.equal(explicit.mode & (process.platform === "win32" ? 0o200 : 0o777), process.platform === "win32" ? 0o200 : 0o600);
    cases++;
    await target.copyIn("default-metadata", source);
    assert.ok(fs.statSync(path.join(targetDir, "default-metadata")).mtimeMs > mtime.getTime() + 60_000);
    cases++;
    if (process.platform !== "win32" && getNativeBinding()?.restoreCopyFileTimes) {
      const descriptor = fs.openSync(source, "r");
      const access = 1_000_000_000_123_456_789n;
      const modified = 1_100_000_000_987_654_321n;
      try { getNativeBinding().restoreCopyFileTimes(descriptor, access, modified); }
      finally { fs.closeSync(descriptor); }
      await target.copyIn("nanoseconds", source, { preserveMetadata: true });
      const precise = fs.statSync(path.join(targetDir, "nanoseconds"), { bigint: true });
      assert.equal(precise.atimeNs, access);
      assert.equal(precise.mtimeNs, modified);
      cases++;
    }
    const capability = { open() { throw Error("must not open"); }, stat() { throw Error("must not stat"); } };
    await assert.rejects(target.copyIn("capability", { root: capability, relativePath: "anything" }, { sourceSymlinks: "copy-link" }), { code: "invalid-path" });
    await assert.rejects(target.copyIn("missing", path.join(directory, "missing"), { sourceSymlinks: "copy-link" }), { name: "FsSafeError", code: "not-found" });
    cases++;
    for (const type of ["file", "dir"]) {
      const link = path.join(directory, `dangling-${type}`);
      fs.symlinkSync(`absent-${type}`, link, type);
      if (!canCopyLinks) {
        await assert.rejects(target.copyIn(`link-${type}`, link, { sourceSymlinks: "copy-link" }), { code: "helper-unavailable" });
        await assert.rejects(target.copyIn(`overwrite-${type}`, link, { sourceSymlinks: "copy-link", overwrite: true }), { code: "invalid-path" });
        cases++;
        continue;
      }
      const destination = path.join(targetDir, `link-${type}`);
      fs.lutimesSync(link, atime, mtime);
      await target.copyIn(`link-${type}`, link, { sourceSymlinks: "copy-link", preserveMetadata: true });
      assert.ok(fs.lstatSync(destination).isSymbolicLink());
      assert.ok(Math.abs(fs.lstatSync(destination).mtimeMs - mtime.getTime()) <= 1, "link timestamp");
      assert.equal(fs.readlinkSync(destination), fs.readlinkSync(link));
      if (process.platform === "win32") {
        assert.equal(attributes(destination) & 0x10, type === "dir" ? 0x10 : 0);
        attributes(link, attributes(link) | 1);
        await target.copyIn(`readonly-link-${type}`, link, { sourceSymlinks: "copy-link", preserveSourceMode: true, preserveMetadata: true });
        assert.equal(attributes(path.join(targetDir, `readonly-link-${type}`)) & 1, 1);
        await target.copyIn(`writable-link-${type}`, link, { sourceSymlinks: "copy-link", preserveSourceMode: true, mode: 0o600 });
        assert.equal(attributes(path.join(targetDir, `writable-link-${type}`)) & 1, 0);
        await target.copyIn(`owner-readonly-link-${type}`, link, { sourceSymlinks: "copy-link", mode: 0o460 });
        assert.equal(attributes(path.join(targetDir, `owner-readonly-link-${type}`)) & 1, 1);
        attributes(link, attributes(link) & ~1);
        cases += 3;
      }
      if (process.platform === "darwin") {
        fs.lchmodSync(link, 0o751);
        await target.copyIn(`source-mode-link-${type}`, link, { sourceSymlinks: "copy-link", preserveSourceMode: true });
        assert.equal(fs.lstatSync(path.join(targetDir, `source-mode-link-${type}`)).mode & 0o777, 0o751);
        await target.copyIn(`explicit-mode-link-${type}`, link, { sourceSymlinks: "copy-link", mode: 0o451, preserveSourceMode: true });
        assert.equal(fs.lstatSync(path.join(targetDir, `explicit-mode-link-${type}`)).mode & 0o777, 0o451);
        cases += 2;
      }
      await assert.rejects(target.copyIn(`link-${type}`, link, { sourceSymlinks: "copy-link" }), { code: "already-exists" });
      await assert.rejects(target.copyIn(`explicit-overwrite-${type}`, link, { sourceSymlinks: "copy-link", overwrite: true }), { code: "invalid-path" });
      assert.equal(fs.existsSync(path.join(targetDir, `explicit-overwrite-${type}`)), false);
      cases += 3;
    }
    const resolved = path.join(directory, "resolved-link");
    fs.symlinkSync("source", resolved, "file");
    for (const [name, options] of [["reject-default", undefined], ["reject-explicit", { sourceSymlinks: "reject" }]]) {
      await assert.rejects(target.copyIn(name, resolved, options), {
        name: "FsSafeError", code: "symlink", message: "symlink not allowed",
      });
      assert.equal(fs.existsSync(path.join(targetDir, name)), false);
      cases++;
    }
    await assert.rejects(target.copyIn("reject-follow", resolved, { sourceSymlinks: "follow" }), { code: "invalid-path" });
    assert.equal(fs.existsSync(path.join(targetDir, "reject-follow")), false);
    cases++;
    if (canCopyLinks) {
      let revoked = false;
      await assert.rejects(target.copyIn("revoked", resolved, {
        sourceSymlinks: "copy-link",
        assertBeforeMutation() { if (revoked) throw Error("revoked"); revoked = true; },
      }), /revoked/);
      assert.equal(fs.existsSync(path.join(targetDir, "revoked")), false);
      cases++;
      let swapped = false;
      await assert.rejects(target.copyIn("swapped-source", resolved, {
        sourceSymlinks: "copy-link",
        assertBeforeMutation() {
          if (!swapped) {
            swapped = true;
            fs.unlinkSync(resolved);
            fs.symlinkSync("another-target", resolved, "file");
          }
        },
      }), { code: "path-mismatch" });
      assert.equal(fs.existsSync(path.join(targetDir, "swapped-source")), false);
      cases++;
    }
    assert.equal(fs.readdirSync(targetDir).some(name => name.startsWith(".fs-safe-")), false);
    return { filesystem, cases };
  } finally {
    if (process.platform === "win32") {
      for (const name of fs.readdirSync(directory, { recursive: true })) {
        try { fs.chmodSync(path.join(directory, name), 0o600); } catch {}
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
async function run() {
  const results = [await prove(os.tmpdir(), process.platform === "win32" ? "ntfs" : process.platform)];
  if (process.env.FS_SAFE_CLONE_TEST_ROOT) results.push(await prove(process.env.FS_SAFE_CLONE_TEST_ROOT, "refs"));
  return { runtime: process.versions.bun ? "bun" : "node", arch: process.arch, mode, thread: isMainThread ? "main" : "worker", results };
}
if (isMainThread) {
  console.log(JSON.stringify(await run()));
  await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { mode, expectMissing } });
    worker.on("message", value => console.log(JSON.stringify(value)));
    worker.on("error", reject);
    worker.on("exit", code => code === 0 ? resolve() : reject(Error(`worker exited ${code}`)));
  });
} else parentPort.postMessage(await run());
