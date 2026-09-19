import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export function registerCreation({ api: a, workspace, register: add, contract }) {
  const directory = path.join(workspace, "exclusive-creation");
  fs.mkdirSync(directory);
  const target = path.join(directory, "leaf");
  const empty = () => assert.deepEqual(fs.readdirSync(directory), []);
  const remove = () => fs.rmSync(target, { force: true, recursive: true });
  const mode = value => value & ~process.umask();
  const unavailable = name => typeof a[name] === "function"
    ? undefined : `The selected distribution does not export ${name}.`;
  for (const suffix of ["", "Sync"]) {
    const name = `createDirectory${suffix}`;
    const node = suffix ? () => fs.mkdirSync(target, { mode: 0o700 })
      : () => fsp.mkdir(target, { mode: 0o700 });
    const after = () => {
      try {
        const stat = fs.lstatSync(target);
        assert(stat.isDirectory());
        assert.deepEqual(fs.readdirSync(target), []);
        if (process.platform !== "win32") assert.equal(stat.mode & 0o777, mode(0o700));
      } finally { remove(); }
    };
    add(`${name}/exclusive-leaf`, () => a[name](target, { mode: 0o700 }), {
      sync: Boolean(suffix), before: empty, after, skip: unavailable(name),
    });
    add(`node.mkdir${suffix}/exclusive-leaf`, node, {
      covers: [], sync: Boolean(suffix), before: empty, after,
    });
  }

  const data = Buffer.from("created descriptor remains writable\n");
  const fileMode = 0o600;
  for (const safe of [true, false]) {
    const fdOf = value => safe ? value.fd : value;
    const close = value => safe ? value[Symbol.dispose]() : fs.closeSync(value);
    add(safe ? "createFileSync/exclusive-leaf" : "node.openSync/exclusive-leaf", () =>
      safe ? a.createFileSync(target, { mode: fileMode }) : fs.openSync(target, "wx+", fileMode), {
      ...(safe ? { skip: unavailable("createFileSync") } : { covers: [] }),
      sync: true,
      before: empty,
      after: value => {
        if (value === undefined) {
          remove();
          assert.fail("exclusive file creation returned no descriptor");
        }
        const fd = fdOf(value);
        try {
          const opened = fs.fstatSync(fd, { bigint: true });
          const named = fs.lstatSync(target, { bigint: true });
          assert(opened.isFile() && named.isFile());
          assert.equal(opened.size, 0n);
          assert.equal(opened.nlink, 1n);
          assert.equal(opened.dev, named.dev);
          assert.equal(opened.ino, named.ino);
          if (process.platform !== "win32") assert.equal(Number(opened.mode & 0o777n), mode(fileMode));
          fs.writeFileSync(fd, data);
          assert.deepEqual(fs.readFileSync(target), data);
        } finally {
          try { close(value); } finally { remove(); }
        }
        assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
      },
    });
  }

  if (typeof a.createFileSync === "function") {
    const owned = a.createFileSync(target, { mode: fileMode });
    try { contract("OwnedFileDescriptorSync", owned); }
    finally { try { owned.close(); } finally { remove(); } }
    for (const method of ["close", Symbol.dispose]) {
      const name = typeof method === "symbol" ? "[Symbol.dispose]" : method;
      add(`OwnedFileDescriptorSync.${name}`, file => file[method](), {
        sync: true,
        before: () => { empty(); return a.createFileSync(target, { mode: fileMode }); },
        after: (_, file) => {
          try {
            assert.throws(() => fs.fstatSync(file.fd), { code: "EBADF" });
            assert.equal(fs.statSync(target).size, 0);
          } finally { try { file.close(); } finally { remove(); } }
        },
      });
    }
  }
  add("node.closeSync/exclusive-leaf", fd => fs.closeSync(fd), {
    covers: [], sync: true,
    before: () => { empty(); return fs.openSync(target, "wx+", fileMode); },
    after: (_, fd) => {
      try {
        assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
        assert.equal(fs.statSync(target).size, 0);
      } finally { remove(); }
    },
  });
}
