import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const ATOMIC_SETTLEMENT_NAMES = Object.freeze([
  "replaceFileAtomic/settlement/success",
  "replaceFileAtomicSync/settlement/success",
  "FileStoreSync.write/settlement/success",
]);

export function registerAtomicSettlement({ api, workspace, register }) {
  const fixture = path.join(workspace, "atomic-settlement");
  const atomicTarget = path.join(fixture, "atomic-target");
  const storeRoot = path.join(fixture, "store");
  const storeTarget = path.join(storeRoot, "value");
  const content = Buffer.from("atomic settlement benchmark\n");
  fs.mkdirSync(storeRoot, { recursive: true });
  const store = api.fileStoreSync({ rootDir: storeRoot, durable: false });
  const options = {
    divisor: 20,
    workloadSemantics:
      "successful replacement of an existing regular file; fixture setup and verification are untimed",
    workloadDetails: {
      bytes: content.byteLength,
      destination: "existing",
      durable: false,
      settlement: "publication-then-retained-handle-close",
    },
  };

  register(
    ATOMIC_SETTLEMENT_NAMES[0],
    () => api.replaceFileAtomic({ filePath: atomicTarget, content }),
    {
      ...options,
      before: () => fs.writeFileSync(atomicTarget, "previous"),
      verify: result => {
        assert.deepEqual(result, { method: "rename" });
        assert.deepEqual(fs.readFileSync(atomicTarget), content);
      },
    },
  );
  register(
    ATOMIC_SETTLEMENT_NAMES[1],
    () => api.replaceFileAtomicSync({ filePath: atomicTarget, content }),
    {
      ...options,
      sync: true,
      before: () => fs.writeFileSync(atomicTarget, "previous"),
      verify: result => {
        assert.deepEqual(result, { method: "rename" });
        assert.deepEqual(fs.readFileSync(atomicTarget), content);
      },
    },
  );
  register(
    ATOMIC_SETTLEMENT_NAMES[2],
    () => store.write("value", content, { durable: false }),
    {
      ...options,
      sync: true,
      before: () => fs.writeFileSync(storeTarget, "previous"),
      verify: result => {
        assert.equal(result, storeTarget);
        assert.deepEqual(fs.readFileSync(storeTarget), content);
      },
    },
  );
}
