import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export function registerRootFileOpenBatch({ api, workspace, register, contract, onCleanup }, readCases) {
  if (typeof api.createRootFileOpenBatchSync !== "function") return;
  register("createRootFileOpenBatchSync", () => api.createRootFileOpenBatchSync(), {
    sync: true,
    after: batch => batch.close(),
  });
  const batch = api.createRootFileOpenBatchSync();
  contract("RootFileOpenBatchSync", batch);
  onCleanup(() => batch.close());
  for (const readCase of readCases) {
    register(`RootFileOpenBatchSync.openFile/${readCase.name}`, () => batch.openFile({
      rootPath: workspace,
      absolutePath: path.join(workspace, readCase.relative),
      maxBytes: readCase.payload.length,
    }), {
      sync: true,
      divisor: readCase.divisor,
      covers: ["RootFileOpenBatchSync.openFile"],
      verify: opened => {
        assert(opened.ok);
        assert.deepEqual(fs.readFileSync(opened.fd), readCase.payload);
      },
      after: opened => { if (opened?.ok) fs.closeSync(opened.fd); },
    });
  }
  for (const [name, dispose] of [["close", batch => batch.close()], ["[Symbol.dispose]", batch => batch[Symbol.dispose]()]]) {
    register(`RootFileOpenBatchSync.${name}`, dispose, {
      sync: true,
      before: () => api.createRootFileOpenBatchSync(),
    });
  }
}
