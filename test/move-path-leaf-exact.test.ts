import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePathWithCopyFallback } from "../src/atomic.js";
import { FsSafeError } from "../src/errors.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

async function fixture(kind: "file" | "symlink", field: "dev" | "ino") {
  const directory = await tempRoot("fs-safe-move-leaf-exact-");
  const source = path.join(directory, "source"), target = path.join(directory, "target"), parked = path.join(directory, "parked");
  await fs.writeFile(path.join(directory, "payload"), "original");
  if (kind === "file") await fs.writeFile(source, "original");
  else await fs.symlink("payload", source);
  const rawStat = fsSync.lstatSync, rawFstat = fsSync.fstatSync;
  const original = rawStat(source), exact = rawStat(source, { bigint: true });
  let replacement: BigIntStats | undefined;
  let observeSource = (stat: Stats | BigIntStats): Stats | BigIntStats => stat;
  let observeOpened = (stat: Stats | BigIntStats, _fd: number): Stats | BigIntStats => stat;
  const wide = 1n << 56n;
  expect(Number(wide)).toBe(Number(wide + 1n));
  const matches = (a: BigIntStats, b: BigIntStats | undefined) => b !== undefined && a.dev === b.dev && a.ino === b.ino;
  function project<T extends Stats | BigIntStats>(stat: T, sameOriginal: boolean): T {
    const retained = typeof stat.ino === "bigint" ? exact : original;
    const identity = { dev: exact.dev, ino: exact.ino, [field]: wide + (sameOriginal ? 0n : 1n) };
    const bigint = typeof stat.ino === "bigint";
    return Object.assign(stat, {
      dev: bigint ? identity.dev : Number(identity.dev), ino: bigint ? identity.ino : Number(identity.ino),
      mode: retained.mode, nlink: retained.nlink, size: retained.size,
      mtimeMs: retained.mtimeMs, ctimeMs: retained.ctimeMs,
      ...(bigint ? { mtimeNs: exact.mtimeNs, ctimeNs: exact.ctimeNs } : {}),
    });
  }
  vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
    const stat = rawStat(candidate, options as never);
    return candidate === source ? observeSource(project(stat, matches(rawStat(source, { bigint: true }), exact))) as never : stat;
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
    const stat = rawFstat(fd, options as never);
    const identity = rawFstat(fd, { bigint: true });
    return matches(identity, exact) || matches(identity, replacement) ? observeOpened(project(stat, matches(identity, exact)), fd) as never : stat;
  });
  function replace() {
    fsSync.renameSync(source, parked);
    if (kind === "file") fsSync.writeFileSync(source, "foreign!");
    else fsSync.symlinkSync("foreign!", source);
    replacement = rawStat(source, { bigint: true });
  }
  return { source, target, parked, replace, fingerprint: exact,
    observeSource: (observe: typeof observeSource) => { observeSource = observe; },
    observeOpened: (observe: typeof observeOpened) => { observeOpened = observe; } };
}

describe("exact copied-move leaf ownership", () => {
  it.each(["dev", "ino"] as const)("accepts an unchanged exact wide %s", async field => {
    const move = await fixture("file", field);
    await movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject" });
    await expect(fs.lstat(move.source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(move.target, "utf8")).toBe("original");
  });

  it.each(["dev", "ino"] as const)("preserves a replacement with a rounded-equal %s", async field => {
    const move = await fixture("file", field);
    await expect(movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject", onDestinationPublished: move.replace }))
      .rejects.toMatchObject({ code: "ESTALE" });
    expect(await fs.readFile(move.source, "utf8")).toBe("foreign!");
    expect(await fs.readFile(move.parked, "utf8")).toBe("original");
    expect(await fs.readFile(move.target, "utf8")).toBe("original");
  });

  it.skipIf(process.platform === "win32")("preserves a symlink replacement with a rounded-equal inode", async () => {
    const move = await fixture("symlink", "ino");
    await expect(movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject", onDestinationPublished: move.replace }))
      .rejects.toMatchObject({ code: "ESTALE" });
    expect(await fs.readlink(move.source)).toBe("foreign!");
    expect(await fs.readlink(move.parked)).toBe("payload");
    expect(await fs.readlink(move.target)).toBe("payload");
  });

  it.each(["before", "after"] as const)("rejects rounded-equal replacement %s opening before publication", async boundary => {
    const move = await fixture("file", "ino"), open = fs.open;
    let closes = 0;
    vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      if (candidate === move.source && boundary === "before") move.replace();
      const handle = await open(candidate, flags, mode);
      if (candidate === move.source) {
        if (boundary === "after") move.replace();
        const close = handle.close.bind(handle);
        handle.close = async () => { closes++; await close(); };
      }
      return handle;
    });
    await expect(movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject" }))
      .rejects.toMatchObject({ code: "ESTALE" });
    expect(closes).toBe(1);
    expect(await fs.readFile(move.source, "utf8")).toBe("foreign!");
    expect(await fs.readFile(move.parked, "utf8")).toBe("original");
    await expect(fs.lstat(move.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["recovered", "persistent", "alternating", "changed-known", "numeric"] as const)("bounds %s Windows cleanup evidence", async kind => {
    const move = await fixture("file", "ino");
    Object.defineProperty(process, "platform", { value: "win32" });
    let published = false, observations = 0;
    move.observeSource(stat => {
      if (!published) return stat;
      observations++;
      const bigint = typeof stat.ino === "bigint";
      if (kind === "numeric") return Object.assign(stat, { dev: Number(stat.dev), ino: Number(stat.ino) });
      if (observations === 1 || kind === "persistent") stat.dev = (bigint ? 0n : 0) as never;
      else if (kind === "alternating" && observations === 2) stat.ino = (bigint ? 0n : 0) as never;
      else if (kind === "changed-known") stat.ino = (bigint ? (stat.ino as bigint) + 1n : Number(stat.ino) + 1) as never;
      return stat;
    });
    const operation = movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject", onDestinationPublished() { published = true; } });
    if (kind === "recovered") await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toMatchObject({ code: "ESTALE" });
    expect(observations).toBe(kind === "recovered" ? 3 : kind === "numeric" ? 1 : 2);
    if (kind === "recovered") await expect(fs.lstat(move.source)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await fs.readFile(move.source, "utf8")).toBe("original");
    expect(await fs.readFile(move.target, "utf8")).toBe("original");
  });

  it.each([false, true])("rechecks unknown evidence introduced by mutation authority, recovers=%s", async recovers => {
    const move = await fixture("file", "ino");
    Object.defineProperty(process, "platform", { value: "win32" });
    let published = false, checkedAuthority = false, observations = 0;
    move.observeSource(stat => {
      if (checkedAuthority) {
        observations++;
        if (!recovers || observations === 1) stat.dev = (typeof stat.dev === "bigint" ? 0n : 0) as never;
      }
      return stat;
    });
    const operation = movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject",
      onDestinationPublished() { published = true; }, assertBeforeMutation() { if (published) checkedAuthority = true; } });
    if (recovers) await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toMatchObject({ code: "ESTALE" });
    expect(observations).toBe(2);
    if (!recovers) expect(await fs.readFile(move.source, "utf8")).toBe("original");
    expect(await fs.readFile(move.target, "utf8")).toBe("original");
  });

  it.each([
    ["admission", new FsSafeError("path-mismatch", "observer failed")],
    ["cleanup", new FsSafeError("path-mismatch", "observer failed")],
    ["admission", undefined], ["cleanup", undefined],
  ] as const)("preserves a caller-owned failure during %s", async (phase, failure) => {
    const move = await fixture("file", "ino");
    let published = false;
    if (phase === "admission") move.observeOpened(() => { throw failure; });
    else move.observeSource(stat => { if (published) throw failure; return stat; });
    await expect(movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject", onDestinationPublished() { published = true; } }))
      .rejects.toBe(failure);
    expect(await fs.readFile(move.source, "utf8")).toBe("original");
    if (phase === "cleanup") expect(await fs.readFile(move.target, "utf8")).toBe("original");
    else await expect(fs.lstat(move.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe.each([1, 2])("unknown Windows source fd at observation %s", boundary => {
    it.each([false, true])("retries without reopening, recovers=%s", async recovers => {
      const move = await fixture("file", "ino"), open = fs.open;
      Object.defineProperty(process, "platform", { value: "win32" });
      let observations = 0, opens = 0, closes = 0, sourceFd: number;
      vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
        const handle = await open(candidate, flags, mode);
        if (candidate === move.source) {
          opens++; sourceFd = handle.fd; const close = handle.close.bind(handle);
          handle.close = async () => { closes++; await close(); };
        }
        return handle;
      });
      move.observeOpened((stat, fd) => {
        expect(fd).toBe(sourceFd); observations++;
        if (observations === boundary || (!recovers && observations >= boundary)) stat.dev = (typeof stat.dev === "bigint" ? 0n : 0) as never;
        return stat;
      });
      const operation = movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject" });
      if (recovers) await expect(operation).resolves.toBeUndefined();
      else await expect(operation).rejects.toMatchObject({ code: "ESTALE" });
      expect(opens).toBe(1); expect(closes).toBe(1);
      expect(observations).toBe(recovers || boundary === 2 ? 3 : 2);
      if (recovers) expect(await fs.readFile(move.target, "utf8")).toBe("original");
      else {
        await expect(fs.lstat(move.target)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(move.source, "utf8")).toBe("original");
      }
    });
  });

  it.each([false, true])("limits the Windows open ctime exception, changes again=%s", async changesAgain => {
    const move = await fixture("file", "ino");
    Object.defineProperty(process, "platform", { value: "win32" });
    let opened = 0;
    move.observeOpened(stat => {
      opened++;
      if (typeof stat.ino === "bigint") (stat as BigIntStats).ctimeNs = move.fingerprint.ctimeNs + (opened > 1 && changesAgain ? 2n : 1n);
      return stat;
    });
    move.observeSource(stat => {
      if (opened && typeof stat.ino === "bigint") (stat as BigIntStats).ctimeNs = move.fingerprint.ctimeNs + 1n;
      return stat;
    });
    const operation = movePathWithCopyFallback({ from: move.source, to: move.target, sourceHardlinks: "reject" });
    if (changesAgain) {
      await expect(operation).rejects.toMatchObject({ code: "ESTALE" });
      expect(await fs.readFile(move.source, "utf8")).toBe("original");
      await expect(fs.lstat(move.target)).rejects.toMatchObject({ code: "ENOENT" });
    } else await expect(operation).resolves.toBeUndefined();
  });

  it.each(["colliding", "recovered", "persistent", "mtime-ns", "backward-ctime-ns", "open-ctime", "external-ctime"] as const)("retains exact alias transitions: %s", async effect => {
    const directory = await tempRoot("fs-safe-move-exact-groups-");
    const source = path.join(directory, "source"), target = path.join(directory, "target");
    await fs.mkdir(source);
    const groups: Array<{ stat: BigIntStats; outside: string; content: string }> = [];
    for (const [name, content] of [["left", "alpha"], ["right", "bravo"]]) {
      const first = path.join(source, `${name}-a`), outside = path.join(directory, name!);
      await fs.writeFile(first, content!);
      await fs.link(first, path.join(source, `${name}-b`)); await fs.link(first, outside);
      groups.push({ stat: fsSync.lstatSync(first, { bigint: true }), outside, content: content! });
    }
    const lstat = fsSync.lstatSync, fstat = fsSync.fstatSync, rename = fs.rename, unlink = fs.unlink, open = fs.open;
    const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
    const reference = groups[0]!.stat;
    const ctimes = groups.map(() => reference.ctimeNs / 1_000_000n * 1_000_000n + 32n);
    const opening = new Set<number>(), openedNames = new Set<string>();
    const openCounts = [0, 0];
    let externalChange = false;
    let remainingLeft: string | undefined, aliasObservations = 0;
    if (["recovered", "persistent", "open-ctime", "external-ctime"].includes(effect)) Object.defineProperty(process, "platform", { value: "win32" });
    function project<T extends Stats | BigIntStats>(stat: T, actual: BigIntStats): T {
      const index = groups.findIndex(group => same(actual, group.stat));
      if (index < 0) return stat;
      const bigint = typeof stat.ino === "bigint", inode = effect === "colliding" ? (1n << 56n) + BigInt(index) : actual.ino;
      const ctime = effect === "open-ctime" || effect === "external-ctime" ? ctimes[index]! : reference.ctimeNs;
      return Object.assign(stat, {
        ino: bigint ? inode : Number(inode),
        mtimeMs: bigint ? reference.mtimeMs : Number(reference.mtimeNs) / 1e6,
        ctimeMs: bigint ? ctime / 1_000_000n : Number(ctime) / 1e6,
        ...(bigint ? { mtimeNs: reference.mtimeNs, ctimeNs: ctime } : {}),
      });
    }
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      const stat = lstat(candidate, options as never);
      if (effect === "external-ctime" && !externalChange && openCounts[0]! > 0 && String(candidate).startsWith(path.join(source, "left-")) && !openedNames.has(String(candidate))) {
        ctimes[0] = ctimes[0]! + 1n; externalChange = true;
      }
      const projected = String(candidate).startsWith(source + path.sep) ? project(stat, lstat(candidate, { bigint: true })) : stat;
      if (candidate === remainingLeft) {
        aliasObservations++;
        if (effect === "persistent" || (effect === "recovered" && aliasObservations === 1)) projected.dev = (typeof projected.dev === "bigint" ? 0n : 0) as never;
        if (typeof projected.ino === "bigint") {
          if (effect === "mtime-ns") (projected as BigIntStats).mtimeNs += 1n;
          if (effect === "backward-ctime-ns") (projected as BigIntStats).ctimeNs -= 1n;
        }
      }
      return projected;
    });
    vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      const handle = await open(candidate, flags, mode);
      if (String(candidate).startsWith(source + path.sep)) {
        const index = groups.findIndex(group => same(fstat(handle.fd, { bigint: true }), group.stat));
        if (index >= 0) { opening.add(handle.fd); openedNames.add(String(candidate)); openCounts[index] = openCounts[index]! + 1; }
      }
      return handle;
    });
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
      const actual = fstat(fd, { bigint: true });
      const index = groups.findIndex(group => same(actual, group.stat));
      if (opening.delete(fd) && effect === "open-ctime" && index >= 0) ctimes[index] = ctimes[index]! + 1n;
      return project(fstat(fd, options as never), actual);
    });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === source) throw Object.assign(new Error("force copy"), { code: "EXDEV" });
      await rename(from, to);
    });
    vi.spyOn(fs, "unlink").mockImplementation(async candidate => {
      await unlink(candidate);
      if (!remainingLeft && String(candidate).startsWith(path.join(source, "left-"))) {
        remainingLeft = path.join(source, String(candidate).endsWith("-a") ? "left-b" : "left-a");
      }
    });
    const succeeds = effect === "colliding" || effect === "recovered" || effect === "open-ctime";
    const operation = movePathWithCopyFallback({ from: source, to: target, sourceHardlinks: "allow" });
    if (succeeds) await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toMatchObject({ code: "ESTALE" });
    if (effect === "external-ctime") {
      expect(externalChange).toBe(true);
      expect(remainingLeft).toBeUndefined();
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(source)).length).toBe(4);
      for (const group of groups) expect((await fs.stat(group.outside)).nlink).toBe(3);
      return;
    }
    expect(remainingLeft).toBeDefined();
    expect(aliasObservations).toBe(effect === "recovered" ? 3 : ["colliding", "persistent", "open-ctime"].includes(effect) ? 2 : 1);
    if (succeeds) await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await fs.readdir(source)).toEqual([path.basename(remainingLeft!)]);
    for (const [index, group] of groups.entries()) {
      expect(await fs.readFile(group.outside, "utf8")).toBe(group.content);
      expect((await fs.stat(group.outside)).nlink).toBe(!succeeds && index === 0 ? 2 : 1);
    }
    for (const [name, content] of [["left", "alpha"], ["right", "bravo"]]) {
      expect(await fs.readFile(path.join(target, `${name}-a`), "utf8")).toBe(content);
      expect(await fs.readFile(path.join(target, `${name}-b`), "utf8")).toBe(content);
    }
  });
});
