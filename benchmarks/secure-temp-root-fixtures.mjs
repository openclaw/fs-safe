import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export function registerSecureTempRootCoverage({ api, workspace, register }) {
  const base = path.join(workspace, "secure-temp-resolver");
  fs.mkdirSync(base, { mode: 0o700 });
  const verify = (result, expected, mode) => {
    assert.equal(result, expected);
    const stat = fs.lstatSync(expected);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    fs.accessSync(expected, fs.constants.W_OK | fs.constants.X_OK);
    if (process.platform !== "win32") {
      assert.equal(stat.uid, process.getuid());
      assert.equal(stat.mode & 0o7777, mode);
    }
  };
  for (const workload of ["existing", "create", "repair"]) {
    const preferredDir = path.join(base, workload);
    if (workload !== "create") fs.mkdirSync(preferredDir, { mode: 0o700 });
    register(`resolveSecureTempRoot/${workload}`, () => api.resolveSecureTempRoot({
      preferredDir, fallbackPrefix: "unused", tmpdir: () => base, warn() {},
    }), {
      sync: true,
      skip: workload === "repair" && process.platform === "win32"
        ? "Windows secure-temp admission does not repair POSIX modes." : undefined,
      before: () => {
        if (workload === "create") {
          fs.rmSync(preferredDir, { recursive: true, force: true });
          assert.equal(fs.existsSync(preferredDir), false);
        } else if (process.platform !== "win32") {
          fs.chmodSync(preferredDir, workload === "repair" ? 0o777 : 0o700);
          assert.equal(fs.lstatSync(preferredDir).mode & 0o7777, workload === "repair" ? 0o777 : 0o700);
        }
      },
      after: (result) => {
        try { verify(result, preferredDir, 0o700); }
        finally {
          if (workload === "create") fs.rmSync(preferredDir, { recursive: true, force: true });
        }
      },
    });
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const rejected = path.join(base, uid === undefined ? "rejected" : `rejected-${uid}`);
  const payload = "secure temp rejection fixture";
  fs.writeFileSync(rejected, payload, { mode: 0o600 });
  register("resolveSecureTempRoot/reject", () => api.resolveSecureTempRoot({
    fallbackPrefix: "rejected", tmpdir: () => base, warn() {},
  }), {
    sync: true, expectError: true,
    after: (error) => {
      assert.equal(error?.constructor, Error);
      assert.match(error.message, /^Unsafe fallback /);
      assert.equal(fs.lstatSync(rejected).isFile(), true);
      assert.equal(fs.readFileSync(rejected, "utf8"), payload);
    },
  });
}
