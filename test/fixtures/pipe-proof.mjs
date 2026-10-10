import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { isMainThread, parentPort } from "node:worker_threads";
import { createPipe } from "../../dist/pipe.js";

const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
function descriptors() {
  return fs.readdirSync(descriptorDirectory).filter(name => {
    try { fs.fstatSync(Number(name)); return true; } catch { return false; }
  }).sort();
}

export async function provePipe() {
  const completed = [];
  const pipe = createPipe();
  try {
    assert.ok(Object.isFrozen(pipe));
    assert.ok(Object.isFrozen(pipe.reader));
    assert.ok(Object.isFrozen(pipe.writer));
    assert.equal(pipe.atomicCloseOnExec, process.platform !== "darwin");
    assert.ok(fs.fstatSync(pipe.reader.fd).isFIFO());
    assert.ok(fs.fstatSync(pipe.writer.fd).isFIFO());
    completed.push("owned-anonymous-pipe");

    const reopened = fs.openSync(`${descriptorDirectory}/${pipe.reader.fd}`, "r");
    try {
      fs.writeSync(pipe.writer.fd, "one-shot-payload");
      pipe.writer.close();
      assert.equal(fs.readFileSync(reopened, "utf8"), "one-shot-payload");
      assert.equal(fs.readSync(reopened, Buffer.alloc(1), 0, 1, null), 0);
    } finally { fs.closeSync(reopened); }
    completed.push("reopen-and-eof");
    pipe.reader.close();
    // Repeat closes before any allocation can reuse the consumed numbers.
    pipe.reader.close();
    pipe.reader[Symbol.dispose]();
    pipe.writer.close();
    pipe.writer[Symbol.dispose]();
    assert.throws(() => fs.fstatSync(pipe.reader.fd), { code: "EBADF" });
    assert.throws(() => fs.fstatSync(pipe.writer.fd), { code: "EBADF" });
    completed.push("idempotent-close");
  } finally {
    pipe.reader.close();
    pipe.writer.close();
  }

  const inherited = createPipe();
  try {
    const identity = fs.fstatSync(inherited.reader.fd, { bigint: true });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const [reader, writer, dev, ino] = process.argv.slice(1);
      for (const fd of [reader, writer]) {
        let stat;
        try { stat = fs.fstatSync(Number(fd), { bigint: true }); }
        catch (error) { assert.equal(error.code, 'EBADF'); continue; }
        assert.ok(!stat.isFIFO() || stat.dev !== BigInt(dev) || stat.ino !== BigInt(ino));
      }
    `, String(inherited.reader.fd), String(inherited.writer.fd), String(identity.dev), String(identity.ino)], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    completed.push("close-on-exec");
  } finally { inherited.reader.close(); inherited.writer.close(); }

  const streamed = createPipe();
  let stream;
  try {
    stream = fs.createWriteStream("", {
      fd: streamed.writer.fd,
      fs: {
        write: fs.write, writev: fs.writev,
        close(_fd, callback) {
          try { streamed.writer.close(); callback(null); }
          catch (error) { callback(error); }
        },
      },
    });
    const closed = once(stream, "close");
    stream.end("stream-payload");
    await closed;
    assert.equal(fs.readFileSync(streamed.reader.fd, "utf8"), "stream-payload");
    completed.push("stream-native-close");
  } finally {
    stream?.destroy();
    streamed.writer.close();
    streamed.reader.close();
  }

  const before = descriptors();
  for (let i = 0; i < 1000; i++) {
    const cycle = createPipe();
    cycle.reader.close();
    cycle.writer.close();
  }
  assert.deepEqual(descriptors(), before);
  completed.push("1000-cycles-no-leak");
  return completed;
}

if (!isMainThread) {
  const warnings = [];
  process.on("warning", warning => warnings.push(warning.message));
  const completed = await provePipe();
  await new Promise(resolve => setImmediate(resolve));
  parentPort.postMessage({ completed, warnings });
}
