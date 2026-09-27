import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function registerRetainedFile({ api, workspace, binding, register, contract, onCleanup }) {
  const supported = process.platform === "win32" && typeof binding?.retainWindowsFile === "function";
  const directory = path.join(workspace, "retained-file");
  fs.mkdirSync(directory);
  const file = path.join(directory, "backup");
  const bytes = Buffer.from("runner-owned retained bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const owners = new Set();
  onCleanup(() => {
    const errors = [];
    for (const owner of owners) {
      try { owner[Symbol.dispose](); } catch (error) { errors.push(error); }
    }
    owners.clear();
    if (errors.length) throw new AggregateError(errors, "retained benchmark owner cleanup failed");
  });
  const prepare = () => {
    fs.writeFileSync(file, bytes);
    return { directory, basename: "backup", parent: fs.statSync(directory, { bigint: true }),
      expected: { ...fs.statSync(file, { bigint: true }), sha256 }, assertBeforeMutation() {} };
  };
  const settle = (owner) => {
    try { owner?.[Symbol.dispose](); }
    finally {
      owners.delete(owner);
      // Runner-owned fixture only, outside the measured operation.
      fs.rmSync(file, { force: true });
    }
  };
  const admit = () => {
    const result = api.retainFileInDirectory(prepare());
    if (result.status === "retained") owners.add(result.file);
    assert.equal(result.status, "retained", result.status === "retained" ? undefined : JSON.stringify(result));
    return result.file;
  };
  register("retainFileInDirectory", input => api.retainFileInDirectory(input), {
    sync: true, before: prepare,
    after: (result) => {
      const owner = result?.status === "retained" ? result.file : undefined;
      try {
        assert.equal(result.status, supported ? "retained" : "unsupported");
        if (owner) {
          assert.equal(owner.dispose().resources, "closed");
          assert.deepEqual(fs.readFileSync(file), bytes);
        } else {
          assert.equal(result.disposition, "not-attempted");
          assert.equal(result.resources, "closed");
          assert.deepEqual(fs.readFileSync(file), bytes);
        }
      } finally { settle(owner); }
    },
  });
  if (supported) {
    const owner = admit();
    try { contract("RetainedFile", owner); } finally { settle(owner); }
  }
  for (const method of ["remove", "dispose", Symbol.dispose]) {
    const label = typeof method === "symbol" ? "[Symbol.dispose]" : method;
    register(`RetainedFile.${label}`, owner => owner[method](), {
      sync: true, before: admit,
      skip: supported ? undefined : "Retained owners require the maintained Windows NTFS native capability.",
      after: (result, owner) => {
        try {
          const receipt = result ?? owner.dispose();
          assert.equal(receipt.resources, "closed");
          assert.deepEqual(receipt.errors, []);
          assert.equal(receipt.persistence, "not-proven");
          assert.equal(receipt.status, method === "remove" ? "name-absent-after-settlement" : "not-attempted");
          if (method === "remove") assert.equal(fs.existsSync(file), false);
          else assert.deepEqual(fs.readFileSync(file), bytes);
        } finally { settle(owner); }
      },
    });
  }
}
