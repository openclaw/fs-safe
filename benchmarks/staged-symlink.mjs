import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export async function registerStagedSymlink({ api, workspace, native, register, contract }) {
  const skip = !native || !["darwin", "linux"].includes(process.platform)
    ? "Retained symlinks require native Linux/macOS." : undefined;
  const directory = path.join(workspace, "retained-symlink");
  fs.mkdirSync(directory);
  const source = path.join(directory, "stage");
  const destination = path.join(directory, "published");
  const prepare = () => {
    fs.symlinkSync("target", source);
    const stat = fs.lstatSync(source, { bigint: true });
    return {
      directory, basename: "stage",
      expected: { dev: stat.dev, ino: stat.ino, uid: Number(stat.uid), gid: Number(stat.gid),
        ctimeNs: stat.ctimeNs, target: "target" },
      assertBeforeMutation() {},
    };
  };
  const stage = () => api.retainSymlinkInDirectory(prepare());
  const settle = async (owner) => {
    try { await owner?.cleanup(); }
    finally {
      // These are runner-owned private fixture names, never product recovery.
      fs.rmSync(source, { force: true });
      fs.rmSync(destination, { force: true });
    }
  };
  const published = async () => {
    const owner = await stage();
    try { await owner.publish("published"); return owner; }
    catch (error) { await settle(owner); throw error; }
  };
  register("retainSymlinkInDirectory", options => api.retainSymlinkInDirectory(options), {
    skip, before: prepare,
    after: async (owner, options) => {
      try {
        assert.equal(owner.receipt.identity.dev, options.expected.dev);
        assert.equal(owner.receipt.identity.ino, options.expected.ino);
        assert.equal(owner.receipt.target, "target");
      } finally { await settle(owner); }
    },
  });
  if (!skip) {
    const owner = await stage();
    try { contract("StagedSymlink", owner); } finally { await settle(owner); }
  }
  for (const method of ["assertCurrent", "assertPublished", "cleanup", "removePublished"]) {
    register(`StagedSymlink.${method}`, owner => owner[method](), {
      skip,
      before: method === "assertPublished" || method === "removePublished" ? published : stage,
      after: async (result, owner) => {
        try {
          if (method === "cleanup") {
            assert.equal(result.status, "removed");
            assert.equal(result.resources, "closed");
            assert.throws(() => fs.lstatSync(source), { code: "ENOENT" });
          }
          if (method === "removePublished") {
            assert.equal(result, "removed");
            assert.throws(() => fs.lstatSync(destination), { code: "ENOENT" });
          }
        } finally { await settle(owner); }
      },
    });
  }
  register("StagedSymlink.publish", owner => owner.publish("published"), {
    skip, before: stage,
    after: async (result, owner) => {
      try {
        assert.equal(result.status, "published");
        assert.equal(result.staged, owner.receipt);
        const stat = fs.lstatSync(destination, { bigint: true });
        assert.equal(stat.dev, owner.receipt.identity.dev);
        assert.equal(stat.ino, owner.receipt.identity.ino);
        assert.equal(fs.readlinkSync(destination), "target");
      } finally { await settle(owner); }
    },
  });
  register("StagedSymlink.[Symbol.asyncDispose]", owner => owner[Symbol.asyncDispose](), {
    skip, before: stage,
    after: async (_, owner) => {
      try { assert.throws(() => fs.lstatSync(source), { code: "ENOENT" }); }
      finally { await settle(owner); }
    },
  });
}
