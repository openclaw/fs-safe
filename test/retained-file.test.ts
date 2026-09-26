import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retainFileInDirectory, type RetainedFile, type RetainFileInDirectoryOptions } from "../src/advanced.js";
import { getNativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const windows = process.platform === "win32";
const native = windows && !!getNativeBinding()?.retainWindowsFile;
if (windows && process.env.FS_SAFE_NATIVE_MODE === "require" && !native) {
  throw new Error("candidate Windows retained-file binding required");
}
const { tempRoot } = useRealTempDirs();
const owners: RetainedFile[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); });

async function fixture() {
  const directory = fs.realpathSync(await tempRoot("fs-safe-retained-file-"));
  const filePath = path.join(directory, "backup");
  fs.writeFileSync(filePath, "original");
  const parent = fs.statSync(directory, { bigint: true });
  const file = fs.statSync(filePath, { bigint: true });
  const options: RetainFileInDirectoryOptions = {
    directory, parent: { dev: parent.dev, ino: parent.ino }, basename: "backup",
    expected: { dev: file.dev, ino: file.ino, size: file.size, mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs,
      sha256: createHash("sha256").update("original").digest("hex") },
    assertBeforeMutation() {},
  };
  return { directory, filePath, options };
}
function retained(options: RetainFileInDirectoryOptions) {
  const result = retainFileInDirectory(options);
  expect(result.status, result.status === "retained" ? undefined : JSON.stringify(result)).toBe("retained");
  if (result.status !== "retained") throw new Error(JSON.stringify(result));
  owners.push(result.file);
  return result.file;
}

it("rejects numeric, zero and overflowing identity before any platform admission", async () => {
  const { options, filePath } = await fixture();
  for (const ino of [Number.MAX_SAFE_INTEGER, 0n, 1n << 64n]) {
    expect(() => retainFileInDirectory({ ...options, expected: { ...options.expected, ino: ino as bigint } })).toThrow(TypeError);
  }
  expect(fs.readFileSync(filePath, "utf8")).toBe("original");
});

it.runIf(!windows)("reports unsupported without mutation or invoking authority", async () => {
  const { options, filePath } = await fixture();
  const result = retainFileInDirectory({ ...options, assertBeforeMutation() { throw new Error("must not run"); } });
  expect(result).toMatchObject({ status: "unsupported", disposition: "not-attempted", resources: "closed", persistence: "not-proven" });
  expect(fs.readFileSync(filePath, "utf8")).toBe("original");
});

describe.runIf(native)("real Windows retained-file lifecycle", () => {
  it("explicitly removes the admitted identity and reports only settled namespace facts", async () => {
    const { options, filePath } = await fixture();
    let calls = 0;
    const owner = retained({ ...options, assertBeforeMutation() { calls++; } });
    const identity = owner.receipt.identity;
    expect(identity).toMatch(/^[0-9a-f]{16}:[0-9a-f]{32}$/u);
    const result = owner.remove();
    expect(result).toMatchObject({ status: "name-absent-after-settlement", disposition: "accepted", namespace: "absent",
      identity, resources: "closed", persistence: "not-proven", errors: [] });
    expect(fs.existsSync(filePath)).toBe(false);
    fs.writeFileSync(filePath, "replacement");
    expect(owner.remove()).toBe(result);
    expect(owner.dispose()).toBe(result);
    expect(calls).toBe(1);
    expect(fs.readFileSync(filePath, "utf8")).toBe("replacement");
  });

  it("ordinary disposal and using cleanup preserve the file and release sharing restrictions", async () => {
    const { options, filePath } = await fixture();
    const owner = retained(options);
    expect(() => fs.writeFileSync(filePath, "newer")).toThrow();
    owner[Symbol.dispose]();
    expect(owner.remove()).toMatchObject({ status: "not-attempted", disposition: "not-attempted", resources: "closed" });
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
    fs.writeFileSync(filePath, "newer");
    expect(fs.readFileSync(filePath, "utf8")).toBe("newer");
  });

  it("preserves same-content foreign replacement before open", async () => {
    const { options, filePath } = await fixture();
    fs.renameSync(filePath, `${filePath}.old`);
    fs.writeFileSync(filePath, "original");
    expect(retainFileInDirectory(options)).toMatchObject({ status: "preserved-mismatch", resources: "closed", disposition: "not-attempted" });
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
    expect(fs.readFileSync(`${filePath}.old`, "utf8")).toBe("original");
  });

  it("preserves an in-place same-size newer write despite matching file identity", async () => {
    const { options, filePath } = await fixture();
    fs.writeFileSync(filePath, "new-data");
    expect(retainFileInDirectory(options)).toMatchObject({ status: "preserved-mismatch", resources: "closed" });
    expect(fs.readFileSync(filePath, "utf8")).toBe("new-data");
  });

  it("refuses a newer same-content generation and observed named-stream changes", async () => {
    const { options, filePath } = await fixture();
    fs.utimesSync(filePath, new Date(), new Date(Date.now() + 1000));
    expect(retainFileInDirectory(options)).toMatchObject({ status: "preserved-mismatch", resources: "closed" });
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
  });

  it("preserves ACL-denied data and leaves the fixture ACL restorable", async () => {
    const { options, filePath } = await fixture();
    const principal = execFileSync("whoami.exe", [], { encoding: "utf8" }).trim();
    execFileSync("icacls.exe", [filePath, "/deny", `${principal}:(R)`], { stdio: "pipe" });
    try {
      expect(retainFileInDirectory(options)).toMatchObject({ status: "failed", disposition: "not-attempted", resources: "closed" });
    } finally { execFileSync("icacls.exe", [filePath, "/remove:d", principal], { stdio: "pipe" }); }
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
  });

  it("does not round bigint identities above the JS safe integer boundary", async () => {
    const { options, filePath } = await fixture();
    const ino = options.expected.ino ^ (1n << 54n);
    expect(retainFileInDirectory({ ...options, expected: { ...options.expected, ino } })).toMatchObject({ status: "preserved-mismatch" });
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
  });

  it("denies replacement and parent rename after open, including at authority admission", async () => {
    const { options, directory, filePath } = await fixture();
    const owner = retained({ ...options, assertBeforeMutation() {
      expect(() => fs.renameSync(filePath, `${filePath}.moved`)).toThrow();
      expect(() => fs.renameSync(directory, `${directory}.moved`)).toThrow();
      expect(() => fs.writeFileSync(filePath, "newer")).toThrow();
    } });
    expect(() => fs.unlinkSync(filePath)).toThrow();
    expect(owner.remove().status).toBe("name-absent-after-settlement");
  });

  it("refuses a replaced parent and retains both original and foreign payloads", async () => {
    const { options, directory, filePath } = await fixture();
    const moved = path.join(directory, "old-parent");
    // Move a child parent so the fixture owns cleanup of both paths.
    const parent = path.join(directory, "parent");
    fs.mkdirSync(parent);
    fs.renameSync(filePath, path.join(parent, "backup"));
    const parentStat = fs.statSync(parent, { bigint: true });
    fs.renameSync(parent, moved);
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, "backup"), "foreign!");
    expect(retainFileInDirectory({ ...options, directory: parent, parent: parentStat })).toMatchObject({ status: "preserved-mismatch", resources: "closed" });
    expect(fs.readFileSync(path.join(parent, "backup"), "utf8")).toBe("foreign!");
    expect(fs.readFileSync(path.join(moved, "backup"), "utf8")).toBe("original");
  });

  it("revocation, async authority and caught reentrancy never admit deletion", async () => {
    const { options, filePath } = await fixture();
    const rejection = { revoked: true };
    const revoked = retained({ ...options, assertBeforeMutation() { throw rejection; } });
    expect(revoked.remove()).toMatchObject({ status: "not-attempted", resources: "closed", errors: [{ cause: rejection }] });
    const asyncOwner = retained({ ...options, assertBeforeMutation: async () => {} });
    expect(asyncOwner.remove()).toMatchObject({ status: "not-attempted", disposition: "not-attempted" });
    let owner: RetainedFile;
    owner = retained({ ...options, assertBeforeMutation() { try { owner.dispose(); } catch { /* Deliberately caught. */ } } });
    expect(owner.remove()).toMatchObject({ status: "not-attempted", resources: "closed" });
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
  });

  it("copied receipts and methods do not authorize removal; inputs are captured", async () => {
    const { options, filePath } = await fixture();
    const mutable = { ...options, expected: { ...options.expected } };
    const owner = retained(mutable);
    mutable.expected.ino = 1n;
    mutable.assertBeforeMutation = () => { throw new Error("late replacement"); };
    const copy = { ...owner.receipt, remove: owner.remove };
    expect(() => copy.remove()).toThrow(TypeError);
    expect(owner.receipt.expected.ino).toBe(options.expected.ino);
    expect(owner.remove().status).toBe("name-absent-after-settlement");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("refuses hardlinks, alternate streams and read-only files without changing them", async () => {
    const { options, filePath } = await fixture();
    fs.linkSync(filePath, `${filePath}.link`);
    expect(retainFileInDirectory(options)).toMatchObject({ status: "preserved-mismatch", resources: "closed" });
    fs.unlinkSync(`${filePath}.link`);
    fs.writeFileSync(`${filePath}:stream`, "stream");
    expect(retainFileInDirectory({ ...options, basename: "backup:stream" }).status).not.toBe("retained");
    expect(fs.readFileSync(`${filePath}:stream`, "utf8")).toBe("stream");
    fs.chmodSync(filePath, 0o444);
    try {
      expect(retainFileInDirectory(options)).toMatchObject({ status: "failed", disposition: "not-attempted", resources: "closed" });
      expect(fs.readFileSync(filePath, "utf8")).toBe("original");
    } finally { fs.chmodSync(filePath, 0o600); }
  });
});
