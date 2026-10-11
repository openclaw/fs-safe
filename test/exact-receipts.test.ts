import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publishFileExclusive } from "../src/publish-file.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { sameFileIdentity } from "../src/file-identity.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import fc from "fast-check";
import { exactFileIdentity, numberStats } from "../src/exact-identity.js";
import { root } from "../src/index.js";
import { openRootFileSync, copyRootFileSync } from "../src/advanced.js";
import { readRegularFile, readRegularFileSync, statRegularFileSync } from "../src/regular-file.js";
import { readSecureFile } from "../src/secure-file.js";
import { pinDirectory } from "../src/directory-durability.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __setFsSafeTestHooksForTest(); __resetFsSafeNativeConfigForTest(); });

it.each([false, true])("round-trips a publication receipt with unsafe IDs (copy=%s)", async copy => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("exact-receipts-");
  const source = path.join(directory, "source"), target = path.join(directory, "target");
  await fs.writeFile(source, "receipt round trip");
  const fstat = fsSync.fstatSync, lstat = fsSync.lstatSync;
  let lastFileObservation: fsSync.BigIntStats | undefined;
  const ino = 2n ** 54n + 1n;
  const project = (stat: fsSync.Stats | fsSync.BigIntStats) => {
    if (stat.isFile()) Object.assign(stat, { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
    return stat;
  };
  vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fstat>) => {
    const observed = project(fstat(...args));
    if (observed.isFile() && typeof observed.ino === "bigint") lastFileObservation = observed as fsSync.BigIntStats;
    return observed;
  }) as typeof fstat);
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof lstat>) => {
    const stat = lstat(...args);
    return stat && project(stat);
  }) as typeof lstat);
  if (copy) vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
  const receipt = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" });
  expect(sameFileIdentity(receipt.identity, receipt.identity, "win32")).toBe(false);
  const exact = (receipt as typeof receipt & { exactIdentity: { dev: bigint; ino: bigint } }).exactIdentity;
  if (exact) expect(exact).toEqual({ dev: lastFileObservation!.dev, ino: lastFileObservation!.ino });
  await expect(publishFileExclusive({ sourcePath: target, targetPath: path.join(directory, "next"), strategy: "link-required", expectedSourceIdentity: exact ?? receipt.identity })).resolves.toMatchObject({ method: "hardlink" });
  expect(exact.ino).toBe(ino);
  await expect(publishFileExclusive({ sourcePath: target, targetPath: path.join(directory, "whole"), strategy: "link-required", expectedSourceIdentity: receipt })).resolves.toMatchObject({ exactIdentity: exact });
  __setFsSafeTestHooksForTest({ beforePublishDirectorySync() { throw new Error("sync failure"); } });
  await expect(publishFileExclusive({ sourcePath: target, targetPath: path.join(directory, "preserved"), strategy: "link-required", onSyncFailure: "preserve" })).rejects.toMatchObject({ details: { exactTargetIdentity: exact, cleanup: "preserved" } });
});

it("projects metadata and exact companions from one bigint descriptor observation", async () => {
  const directory = await tempRoot("exact-property-");
  const file = path.join(directory, "file");
  await fs.writeFile(file, "bytes");
  const handle = await fs.open(file);
  try {
    const observation = fsSync.fstatSync(handle.fd, { bigint: true });
    for (const ns of [1_700_000_000_000_750_000n, -750_000n]) {
      const projected = numberStats(Object.assign(Object.create(observation), { mtimeNs: ns }));
      expect(Object.hasOwn(projected, "mtime")).toBe(false);
      expect(projected.mtimeMs).toBe(Number(ns) / 1_000_000);
      expect(projected.mtime.getTime()).toBe(Math.round(projected.mtimeMs));
    }
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 2n ** 64n - 1n }), fc.bigInt({ min: 1n, max: 2n ** 64n - 1n }), (dev, ino) => {
      const signed = { dev: BigInt.asIntN(64, dev), ino: BigInt.asIntN(64, ino) };
      const stat = Object.assign(Object.create(observation), signed);
      const exact = exactFileIdentity(stat);
      const legacy = numberStats(stat);
      expect(exact).toEqual(signed);
      expect(Object.isFrozen(exact)).toBe(true);
      expect(legacy).toBeInstanceOf(fsSync.Stats);
      expect(legacy.ino).toBe(Number(ino));
      expect(legacy.dev).toBe(Number(dev));
      expect(sameFileIdentity({ exactIdentity: exact }, stat)).toBe(true);
      // Zero is an unknown Windows component, not a definite different inode.
      const differentIno = signed.ino === -1n ? -2n : signed.ino + 1n;
      expect(sameFileIdentity({ exactIdentity: exact }, { dev: signed.dev, ino: differentIno })).toBe(false);
    }));
  } finally { await handle.close(); }
});

it("returns exact companions for public open, read, stat, directory and temp receipts", async () => {
  const directory = await tempRoot("exact-public-");
  const file = path.join(directory, "file");
  await fs.writeFile(file, "bytes", { mode: 0o600 });
  const capability = await root(directory);
  const opened = await capability.open("file");
  try {
    const observed = exactFileIdentity(fsSync.fstatSync(opened.handle.fd, { bigint: true }));
    expect(opened.exactIdentity).toEqual(observed);
    const writable = await capability.openWritable("file", { writeMode: "update" });
    try { expect(writable.exactIdentity).toEqual(exactFileIdentity(fsSync.fstatSync(writable.handle.fd, { bigint: true }))); }
    finally { await writable.handle.close(); }
    const pinned = openRootFileSync({ absolutePath: file, rootPath: directory, boundaryLabel: "proof" });
    expect(pinned.ok).toBe(true);
    if (pinned.ok) {
      try { expect(pinned.exactIdentity).toEqual(exactFileIdentity(fsSync.fstatSync(pinned.fd, { bigint: true }))); }
      finally { fsSync.closeSync(pinned.fd); }
    }
    for (const result of [await capability.read("file"), await readRegularFile({ filePath: file }), readRegularFileSync({ filePath: file }), statRegularFileSync(file), await readSecureFile({ filePath: file, permissions: { allowInsecure: true } })]) {
      expect(result).toMatchObject({ exactIdentity: observed });
    }
    const stat = await capability.stat("file");
    expect(stat.exactIdentity).toEqual(observed);
    expect(() => JSON.stringify(stat)).not.toThrow();
    expect((await capability.list(".", { withFileTypes: true }))[0]?.exactIdentity).toEqual(observed);
    for await (const entry of capability.entries(".")) expect(entry.exactIdentity).toEqual(observed);
    const copied = copyRootFileSync({ source: { rootPath: directory, absolutePath: file }, destination: { rootPath: directory, absolutePath: path.join(directory, "copy") }, expectedSourceIdentity: opened });
    try { expect(copied.sourceIdentity).toEqual(observed); }
    finally { copied[Symbol.dispose](); }
  } finally { await opened.handle.close(); }
  const pinned = await pinDirectory(directory);
  try {
    expect(pinned.receipt.exactIdentity).toEqual(exactFileIdentity(fsSync.lstatSync(directory, { bigint: true })));
    const copied = await pinDirectory({ ...pinned.receipt });
    await copied.close();
  } finally { await pinned.close(); }
  const options = { rootDir: directory, prefix: "workspace-" };
  const asyncTemp = await tempWorkspace(options), syncTemp = tempWorkspaceSync(options);
  try {
    for (const workspace of [asyncTemp, syncTemp]) expect(workspace.exactIdentity).toEqual(exactFileIdentity(fsSync.lstatSync(workspace.dir, { bigint: true })));
  } finally { await asyncTemp.cleanup(); syncTemp.cleanup(); }
});

it("does not use a malformed companion or match an adjacent exact identity", () => {
  expect(sameFileIdentity({ dev: 1, ino: 2, exactIdentity: undefined } as never, { dev: 1, ino: 2 })).toBe(false);
  expect(sameFileIdentity({ exactIdentity: { dev: 1, ino: 2 } } as never, { dev: 1, ino: 2 })).toBe(false);
});
