import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { ensureSyncStoreDirectory } from "../src/file-store-sync-directory.js";
import { realpathSync } from "../src/realpath.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

itPosix.each(["root", "parent", "target"].flatMap((subject) =>
  ["root", "target"].flatMap((canonical) =>
    ["before-chmod", "after-chmod"].map((phase) => ({ subject, canonical, phase })))))(
  "rejects a $subject replacement after $canonical canonicalization $phase",
  async ({ subject, canonical, phase }) => {
    const container = await tempRoot("fs-safe-sync-store-mode-fence-");
    const root = path.join(container, "store");
    const parent = path.join(root, "parent");
    const target = path.join(parent, "target");
    const displaced = path.join(container, "displaced");
    const outside = path.join(container, "outside");
    await Promise.all([fs.mkdir(target, { recursive: true }), fs.mkdir(outside)]);
    await Promise.all([
      fs.chmod(root, 0o700), fs.chmod(parent, 0o700),
      fs.chmod(target, 0o755), fs.chmod(outside, 0o755),
    ]);
    const changedPath = subject === "root" ? root : subject === "parent" ? parent : target;
    const canonicalPath = canonical === "root" ? root : target;
    const originalOpen = fsSync.openSync.bind(fsSync);
    const originalResolve = realpathSync.native;
    const originalChmod = fsSync.fchmodSync.bind(fsSync);
    let descriptor: number | undefined;
    let repaired = false;
    let replaced = false;
    vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
      const opened = originalOpen(...args);
      if (String(args[0]) === target) descriptor = opened;
      return opened;
    }) as typeof fsSync.openSync);
    const chmod = vi.spyOn(fsSync, "fchmodSync").mockImplementation((opened, mode) => {
      originalChmod(opened, mode);
      if (opened === descriptor) repaired = true;
    });
    vi.spyOn(realpathSync, "native").mockImplementation((input) => {
      const resolved = originalResolve(input);
      if (!replaced && descriptor !== undefined && input === canonicalPath &&
        repaired === (phase === "after-chmod")) {
        fsSync.renameSync(changedPath, displaced);
        fsSync.symlinkSync(outside, changedPath, "dir");
        replaced = true;
      }
      return resolved;
    });
    const close = vi.spyOn(fsSync, "closeSync");

    expect(() => ensureSyncStoreDirectory({
      rootDir: root, targetDir: target, mode: 0o700, messagePrefix: "store",
    })).toThrow(expect.objectContaining({ code: "outside-workspace" }));

    expect(replaced).toBe(true);
    expect(chmod).toHaveBeenCalledTimes(phase === "after-chmod" ? 1 : 0);
    expect(close).toHaveBeenCalledExactlyOnceWith(descriptor);
    expect((await fs.stat(outside)).mode & 0o7777).toBe(0o755);
  },
);

itPosix.each(["root", "component"])(
  "checks the latest $subject mode after final canonicalization",
  async (subject) => {
    const root = await tempRoot("fs-safe-sync-store-mode-final-observation-");
    const target = subject === "root" ? root : path.join(root, "nested");
    if (target !== root) await fs.mkdir(target);
    await fs.chmod(root, 0o700);
    await fs.chmod(target, 0o755);
    const originalResolve = realpathSync.native;
    const originalFstat = fsSync.fstatSync.bind(fsSync);
    let descriptorChecks = 0;
    let changed = false;
    vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args) => {
      descriptorChecks += 1;
      return originalFstat(...args);
    }) as typeof fsSync.fstatSync);
    vi.spyOn(realpathSync, "native").mockImplementation((input) => {
      const resolved = originalResolve(input);
      if (!changed && input === target && descriptorChecks === 2) {
        fsSync.chmodSync(target, 0o777);
        changed = true;
      }
      return resolved;
    });
    const chmod = vi.spyOn(fsSync, "fchmodSync");
    const close = vi.spyOn(fsSync, "closeSync");

    expect(() => ensureSyncStoreDirectory({
      rootDir: root, targetDir: target, mode: 0o700, messagePrefix: "store",
    })).toThrow(expect.objectContaining({ code: "insecure-permissions" }));

    expect(changed).toBe(true);
    expect(chmod).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect((await fs.stat(target)).mode & 0o7777).toBe(0o777);
  },
);

itPosix.each(["root", "component"].flatMap((subject) =>
  ["before-chmod", "after-chmod"].map((phase) => ({ subject, phase }))))(
  "rejects an ancestor relocation preserving exact $subject identities $phase",
  async ({ subject, phase }) => {
    const container = await tempRoot("fs-safe-sync-store-mode-ancestor-fence-");
    const ancestor = path.join(container, "ancestor");
    const root = path.join(ancestor, "store");
    const target = subject === "root" ? root : path.join(root, "nested");
    const displaced = path.join(container, "displaced");
    await fs.mkdir(target, { recursive: true });
    await fs.chmod(root, 0o700);
    await fs.chmod(target, 0o755);
    const admitted = await fs.stat(target, { bigint: true });
    const originalOpen = fsSync.openSync.bind(fsSync);
    const originalResolve = realpathSync.native;
    const originalChmod = fsSync.fchmodSync.bind(fsSync);
    let descriptor: number | undefined;
    let repaired = false;
    let relocated = false;
    vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
      const opened = originalOpen(...args);
      if (String(args[0]) === target) descriptor = opened;
      return opened;
    }) as typeof fsSync.openSync);
    const chmod = vi.spyOn(fsSync, "fchmodSync").mockImplementation((opened, mode) => {
      originalChmod(opened, mode);
      if (opened === descriptor) repaired = true;
    });
    vi.spyOn(realpathSync, "native").mockImplementation((input) => {
      const resolved = originalResolve(input);
      if (!relocated && descriptor !== undefined && input === target &&
        repaired === (phase === "after-chmod")) {
        fsSync.renameSync(ancestor, displaced);
        fsSync.symlinkSync(displaced, ancestor, "dir");
        relocated = true;
      }
      return resolved;
    });
    const close = vi.spyOn(fsSync, "closeSync");

    expect(() => ensureSyncStoreDirectory({
      rootDir: root, targetDir: target, mode: 0o700, messagePrefix: "store",
    })).toThrow(expect.objectContaining({ code: "outside-workspace" }));

    expect(relocated).toBe(true);
    expect(chmod).toHaveBeenCalledTimes(phase === "after-chmod" ? 1 : 0);
    expect(close).toHaveBeenCalledExactlyOnceWith(descriptor);
    const current = await fs.stat(target, { bigint: true });
    expect({ dev: current.dev, ino: current.ino }).toEqual({ dev: admitted.dev, ino: admitted.ino });
    expect(current.mode & 0o7777n).toBe(phase === "after-chmod" ? 0o700n : 0o755n);
  },
);

itPosix("preserves canonical store receipts beneath an aliased ancestor", async () => {
  const container = await tempRoot("fs-safe-sync-store-canonical-ancestor-");
  const actual = path.join(container, "actual");
  const alias = path.join(container, "alias");
  const root = path.join(alias, "store");
  const target = path.join(root, "nested");
  await fs.mkdir(path.join(actual, "store", "nested"), { recursive: true });
  await fs.symlink(actual, alias, "dir");
  await Promise.all([fs.chmod(root, 0o755), fs.chmod(target, 0o755)]);

  const receipt = ensureSyncStoreDirectory({
    rootDir: root, targetDir: target, mode: 0o700, messagePrefix: "store",
  });

  expect(receipt.dir).toBe(target);
  expect(receipt.realPath).toBe(await fs.realpath(path.join(actual, "store", "nested")));
  expect(receipt.exactStat.ino).toBe((await fs.stat(target, { bigint: true })).ino);
  expect((await fs.stat(root)).mode & 0o7777).toBe(0o700);
  expect((await fs.stat(target)).mode & 0o7777).toBe(0o700);
});
