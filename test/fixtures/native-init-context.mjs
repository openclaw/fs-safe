import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { configureFsSafeNative } from "../../dist/native-config.js";
import { requireNativeBinding } from "../../dist/native.js";

const require = createRequire(import.meta.url);
const scope = new AsyncLocalStorage();
const otherScope = new AsyncLocalStorage();
const finalized = new Set();
const registry = new FinalizationRegistry((tag) => finalized.add(tag));
const references = [];
configureFsSafeNative({ mode: "require" });

// Static imports must leave native loading lazy, so this process exercises
// registration inside its first operation, not an already warmed addon.
assert.equal(Object.keys(require.cache).some((file) => file.endsWith(".node")), false);

async function operation(tag) {
  const caller = { tag };
  const other = { tag: `${tag}-other` };
  for (const value of [caller, other]) {
    references.push(new WeakRef(value));
    registry.register(value, value.tag);
  }
  await scope.run(caller, () => otherScope.run(other, async () => {
    const native = requireNativeBinding();
    assert.equal(scope.getStore(), caller);
    assert.equal(otherScope.getStore(), other);
    const fd = openSync(new URL(import.meta.url), "r");
    try {
      await native.sha256File(fd).then((result) => {
        assert.ok(result.bytes > 0);
        assert.equal(scope.getStore(), caller);
        assert.equal(otherScope.getStore(), other);
      });
    } finally {
      closeSync(fd);
    }
  }));
}

await operation("cold");
await operation("cached");
assert.equal(scope.getStore(), undefined);
assert.equal(otherScope.getStore(), undefined);

// Invoke GC in native immediate callbacks, outside promise continuations and
// after WeakRef's creation job. Keep the same bounded barrier on every runtime.
for (let pass = 0; pass < 8; pass++) {
  await new Promise((resolve) => setImmediate(() => {
    globalThis.gc();
    resolve();
  }));
}
await new Promise((resolve) => setImmediate(resolve));
assert.ok(references.every((reference) => reference.deref() === undefined),
  "Native initialization retained a caller AsyncLocalStorage store");
assert.deepEqual([...finalized].sort(), ["cached", "cached-other", "cold", "cold-other"]);
console.log("native initialization: lazy; caller contexts preserved and collected");
