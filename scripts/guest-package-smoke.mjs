import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const consumer = resolve(process.argv[2] ?? ".");
const require = createRequire(join(consumer, "package.json"));
const guest = await import(pathToFileURL(require.resolve("@openclaw/fs-safe/guest")));
assert.equal(guest.GUEST_FILESYSTEM_CREATE_EXISTS_EXIT_CODE, 17);
assert.equal(guest.GUEST_FILESYSTEM_READ_NOT_FOUND_EXIT_CODE, 2);
assert.equal(typeof guest.GUEST_FILESYSTEM_PYTHON, "string");
assert.equal(typeof guest.GUEST_FILESYSTEM_RENAME_NO_REPLACE_PYTHON, "string");

if (process.platform === "win32") {
  console.log("guest package import passed; execution requires a Linux/macOS Python guest");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "fs-safe-guest-package-"));
let crossDeviceRoot;
function run(args, input, expected = 0, source = guest.GUEST_FILESYSTEM_PYTHON) {
  const result = spawnSync("python3", ["-c", source, ...args], {
    input,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected, result.stderr.toString());
  return result.stdout;
}

try {
  const name = "quoted ' $ ; \\: ü.bin";
  const payload = Buffer.from(Array.from({ length: 131_089 }, (_, index) => index % 256));
  run(["write", workspace, "nested", name, "1"], payload);
  assert.deepEqual(run(["read", workspace, "nested", name, String(payload.length)]), payload);
  run(["create", workspace, "nested", name, "0"], Buffer.from("loser"), 17);
  assert.deepEqual(readFileSync(join(workspace, "nested", name)), payload);
  run(["read", workspace, "nested", "missing"], undefined, 2);
  run(["read", workspace, "nested", name, String(payload.length - 1)], undefined, 1);
  run(["copy", workspace, "nested", name, workspace, "", "copied.bin", "0"]);
  assert.deepEqual(readFileSync(join(workspace, "copied.bin")), payload);
  assert.deepEqual(readdirSync(join(workspace, "nested")), [name]);

  const fragment = [
    "import ctypes, errno, os, sys",
    guest.GUEST_FILESYSTEM_RENAME_NO_REPLACE_PYTHON,
    "fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)",
    "try:",
    "    rename_no_replace(fd, sys.argv[2], fd, sys.argv[3])",
    "finally:",
    "    os.close(fd)",
  ].join("\n");
  run([workspace, "copied.bin", "published.bin"], undefined, 0, fragment);
  assert.deepEqual(readFileSync(join(workspace, "published.bin")), payload);
  writeFileSync(join(workspace, "contender.bin"), "contender");
  run([workspace, "contender.bin", "published.bin"], undefined, 1, fragment);
  assert.deepEqual(readFileSync(join(workspace, "published.bin")), payload);
  assert.equal(readFileSync(join(workspace, "contender.bin"), "utf8"), "contender");

  if (process.argv.includes("--cross-device")) {
    assert.equal(process.platform, "linux", "cross-device proof requires Linux /dev/shm");
    crossDeviceRoot = mkdtempSync("/dev/shm/fs-safe-guest-package-");
    assert.notEqual(statSync(workspace).dev, statSync(crossDeviceRoot).dev);
    mkdirSync(join(workspace, "tree"));
    writeFileSync(join(workspace, "tree", "payload.bin"), payload);
    run(["rename", workspace, "", "tree", crossDeviceRoot, "", "moved", "0"]);
    assert.deepEqual(readFileSync(join(crossDeviceRoot, "moved", "payload.bin")), payload);
    assert.equal(readdirSync(workspace).includes("tree"), false);
    console.log("guest installed-package real cross-device directory move passed");
  }
  console.log("guest installed-package Python protocol and standalone rename fragment passed");
} finally {
  rmSync(workspace, { recursive: true, force: true });
  if (crossDeviceRoot) rmSync(crossDeviceRoot, { recursive: true, force: true });
}
