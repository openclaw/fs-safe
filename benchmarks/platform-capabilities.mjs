import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export function registerPlatformCapabilities({ api, workspace, binding, register, onCleanup }) {
  const file = path.join(workspace, "platform-capability-file");
  fs.writeFileSync(file, Buffer.alloc(4096, 0x5a), { mode: 0o600 });
  const fd = fs.openSync(file, "r");
  onCleanup(() => fs.closeSync(fd));
  const leaseSupported = process.platform === "linux" && Boolean(binding?.tryAcquireWriteLease);
  register("tryAcquireWriteLease", () => {
    if (!leaseSupported) {
      assert.throws(() => api.tryAcquireWriteLease(fd), {
        code: process.platform === "linux" ? "helper-unavailable" : "unsupported-platform",
      });
      return null;
    }
    return api.tryAcquireWriteLease(fd);
  }, {
    sync: true,
    after(lease) {
      if (!leaseSupported) return;
      assert.ok(lease);
      try { assert.equal(lease.isHeld(), true); }
      finally { lease.release(); }
      assert.equal(lease.isHeld(), false);
    },
  });
  register("inspectDarwinAcl", () => api.inspectDarwinAcl(file), {
    sync: true,
    after(result) {
      assert.equal(result.kind, process.platform === "darwin" && binding?.inspectDarwinAcl ? "none" : "unknown");
    },
  });
  const windows = Boolean(process.platform === "win32" && binding?.holdWindowsSharingLock);
  const windowsCall = operation => {
    if (windows) return operation();
    assert.throws(operation, {
      code: process.platform === "win32" ? "helper-unavailable" : "unsupported-platform",
    });
  };
  register("holdWindowsSharingLock", () => windowsCall(() => api.holdWindowsSharingLock(file)), {
    sync: true,
    after(owner) {
      if (windows) {
        assert.ok(owner);
        owner.close(); owner.close();
      }
    },
  });
  register("setWindowsFileAttributes", () => windowsCall(() =>
    api.setWindowsFileAttributes(file, { readOnly: false, hidden: false, system: false })), {
    sync: true,
    after() { assert.equal(fs.statSync(file).size, 4096); },
  });
  register("readWindowsFileExtents", () => windowsCall(() => api.readWindowsFileExtents(file)), {
    sync: true,
    after(extents) {
      if (windows) {
        assert.ok(Array.isArray(extents));
        assert.ok(extents.length > 0);
        assert.equal(extents[0].vcn, 0n);
      }
    },
  });
}
