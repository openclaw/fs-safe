import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { FsSafeError } from "../../dist/errors.js";
import { createPipe } from "../../dist/pipe.js";

function proveExhaustion(thread) {
  // Load the real addon before deliberately exhausting this child's fd limit.
  const warm = createPipe();
  warm.reader.close();
  warm.writer.close();
  const filler = [];
  const failures = [];
  try {
    assert.throws(() => {
      for (;;) filler.push(fs.openSync("/dev/null", "r"));
    }, { code: "EMFILE" });
    for (const spare of [0, 1]) {
      if (spare) fs.closeSync(filler.pop());
      assert.throws(createPipe, error => {
        assert.ok(error instanceof FsSafeError);
        assert.equal(error.code, "helper-failed");
        assert.equal(error.cause?.code, "EMFILE");
        failures.push(error.cause.code);
        return true;
      });
    }
    // A failed two-end allocation must leave the one available slot free.
    const probe = fs.openSync("/dev/null", "r");
    fs.closeSync(probe);
  } finally {
    for (const fd of filler) fs.closeSync(fd);
  }
  const recovered = createPipe();
  recovered.reader.close();
  recovered.writer.close();
  return { thread, failures, recovered: true };
}

if (!isMainThread) {
  parentPort.postMessage(proveExhaustion("worker"));
} else if (process.argv[2] === "worker") {
  const worker = new Worker(new URL(import.meta.url));
  let result;
  worker.on("message", message => { result = message; });
  const [code] = await once(worker, "exit");
  assert.equal(code, 0);
  assert.ok(result);
  console.log(JSON.stringify(result));
} else {
  console.log(JSON.stringify(proveExhaustion("main")));
}
