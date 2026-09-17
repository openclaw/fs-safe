import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileReceipt(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert(stat.isFile() && !stat.isSymbolicLink(), `capture receipt is not a file: ${file}`);
  assert.equal(stat.nlink, 1n, `capture receipt is hardlinked: ${file}`);
  if (process.platform !== "win32") {
    assert.equal(Number(stat.mode & 0o777n), 0o600, `capture file mode is not 0600: ${file}`);
  }
  const bytes = fs.readFileSync(file);
  return { sha256: sha256(bytes), size: bytes.length };
}

export function remoteFileManifest(root) {
  const rootStat = fs.lstatSync(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    `capture root is not a real directory: ${root}`);
  if (process.platform !== "win32") {
    assert.equal(rootStat.mode & 0o777, 0o700, `capture root mode is not 0700: ${root}`);
  }
  const results = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `capture contains a link: ${file}`);
      const stat = fs.lstatSync(file, { bigint: true });
      if (entry.isDirectory()) {
        assert(stat.isDirectory() && !stat.isSymbolicLink(),
          `capture contains an aliased directory: ${file}`);
        if (process.platform !== "win32") {
          assert.equal(Number(stat.mode & 0o777n), 0o700,
            `capture directory mode is not 0700: ${file}`);
        }
        visit(file);
      } else {
        assert(entry.isFile() && stat.isFile(), `capture contains a non-file: ${file}`);
        assert.equal(stat.nlink, 1n, `capture contains a hardlinked file: ${file}`);
        if (process.platform !== "win32") {
          assert.equal(Number(stat.mode & 0o777n), 0o600,
            `capture file mode is not 0600: ${file}`);
        }
        const relative = path.relative(root, file).split(path.sep).join("/");
        results.push({ path: relative, ...fileReceipt(file) });
      }
    }
  };
  visit(root);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}
