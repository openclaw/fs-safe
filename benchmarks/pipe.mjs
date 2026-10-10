import assert from "node:assert/strict";
import fs from "node:fs";

export function registerPipe({ api, binding, register }) {
  const platformSupported = ["linux", "darwin", "freebsd"].includes(process.platform);
  const supported = platformSupported && typeof binding?.createPipe === "function";
  register("createPipe/anonymous", () => api.createPipe(), {
    sync: true,
    expectError: !supported,
    after(pipe) {
      if (!supported) {
        assert.equal(pipe.name, "FsSafeError");
        assert.equal(pipe.code, platformSupported ? "helper-unavailable" : "unsupported-platform");
        return;
      }
      try {
        assert.ok(Object.isFrozen(pipe));
        assert.ok(fs.fstatSync(pipe.reader.fd).isFIFO());
        assert.ok(fs.fstatSync(pipe.writer.fd).isFIFO());
        assert.equal(pipe.atomicCloseOnExec, process.platform !== "darwin");
        fs.writeSync(pipe.writer.fd, "pipe-benchmark");
        pipe.writer.close();
        assert.equal(fs.readFileSync(pipe.reader.fd, "utf8"), "pipe-benchmark");
      } finally {
        try { pipe.writer.close(); } finally { pipe.reader.close(); }
      }
    },
  });
}
