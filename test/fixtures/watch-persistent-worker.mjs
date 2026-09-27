import assert from "node:assert/strict";
import { workerData } from "node:worker_threads";
import { root } from "@openclaw/fs-safe/root";
import { watch } from "@openclaw/fs-safe/watch";
import { getNativeBinding } from "../../dist/native.js";

const subscription = watch(await root(workerData), {
  mode: "events", persistent: false,
  scopes: [{ path: "", kind: "tree" }], onInvalidate() {},
});
await subscription.ready;
assert.equal(getNativeBinding().watchThreadCount(), 1);
