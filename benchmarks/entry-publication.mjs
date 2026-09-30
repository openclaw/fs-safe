import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export function registerEntryPublication({ api, workspace, binding, register, contract, onCleanup }) {
  const supported = ["darwin", "linux"].includes(process.platform) &&
    typeof binding?.publishRetainedEntryNoReplace === "function";
  const directory = path.join(workspace, "entry-publication");
  fs.mkdirSync(directory);
  const source = path.join(directory, "stage"), destination = path.join(directory, "published");
  const owners = new Set();
  const bytes = "managed-publication-fixture";
  const stat = name => fs.lstatSync(name, { bigint: true });
  const payload = (name, kind) => kind === "directory" ? path.join(name, "bytes") : name;
  const prepare = kind => {
    if (kind === "directory") fs.mkdirSync(source);
    fs.writeFileSync(payload(source, kind), bytes);
    const parent = { path: directory, identity: stat(directory) };
    return { source: { parent, basename: "stage", expected: { ...stat(source), kind } },
      destination: { parent, basename: "published" }, assertBeforeMutation() {} };
  };
  const track = owner => { owners.add(owner); return owner; };
  const settle = owner => {
    try {
      if (owner) {
        const result = owner.dispose();
        assert.equal(result.resources, "closed");
        assert.deepEqual(result.issues, []);
      }
    } finally {
      owners.delete(owner);
      // The harness owns both synthetic names, after all synchronous users settle.
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(destination, { recursive: true, force: true });
    }
  };
  onCleanup(() => {
    const failures = [];
    for (const owner of [...owners]) { try { settle(owner); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "publication benchmark settlement failed");
  });
  if (supported) {
    const owner = track(api.retainEntryForPublication(prepare("directory")));
    try { contract("RetainedEntryPublication", owner); } finally { settle(owner); }
  }
  for (const kind of ["directory", "file"]) {
    register(`retainEntryForPublication/${kind}`, input => track(api.retainEntryForPublication(input)), {
      sync: true, before: () => prepare(kind), expectError: !supported,
      after: (output, input) => {
        const owner = supported ? output : undefined;
        try {
          if (supported) {
            assert.equal(owner.receipt.source.expected.ino, input.source.expected.ino);
            assert.equal(owner.dispose().transition, "not-published");
          } else {
            assert.equal(output.code, ["darwin", "linux"].includes(process.platform) ? "helper-unavailable" : "unsupported-platform");
            assert.equal(output.details.result.transition, "not-published");
            assert.equal(output.details.result.resources, "closed");
          }
          assert.equal(fs.readFileSync(payload(source, kind), "utf8"), bytes);
          assert.equal(fs.existsSync(destination), false);
        } finally { settle(owner); }
      },
    });
    for (const method of ["publish", "dispose", Symbol.dispose]) {
      const label = typeof method === "symbol" ? "[Symbol.dispose]" : method;
      register(`RetainedEntryPublication.${label}/${kind}`, owner => owner[method](), {
        sync: true, before: () => track(api.retainEntryForPublication(prepare(kind))),
        skip: supported ? undefined : "One-way entry publication requires a supported local POSIX native filesystem.",
        after: (output, owner) => {
          try {
            const result = output ?? owner.dispose();
            assert.equal(result.resources, "closed"); assert.deepEqual(result.issues, []);
            assert.equal(result.transition, method === "publish" ? "committed" : "not-published");
            if (method === "publish") {
              assert.equal(result.verification, "verified");
              assert.equal(stat(destination).ino, owner.receipt.source.expected.ino);
              assert.equal(fs.existsSync(source), false);
              fs.writeFileSync(payload(destination, kind), "newer");
              owner.dispose();
              assert.equal(fs.readFileSync(payload(destination, kind), "utf8"), "newer");
            } else {
              assert.equal(fs.readFileSync(payload(source, kind), "utf8"), bytes);
              assert.equal(fs.existsSync(destination), false);
            }
          } finally { settle(owner); }
        },
      });
    }
  }
}
