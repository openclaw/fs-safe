import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import { vi } from "vitest";

// Model DrvFS as measured on a real Windows-drive bind mount
// (openclaw/openclaw#193262): a renamed name stays invisible while ANY
// descriptor to the renamed inode is open — including a metadata pin opened
// after the rename. Path lookups and fstat on held descriptors return ENOENT;
// once the last descriptor closes, the name is visible again with an
// unchanged dev/ino identity, and no timer makes it visible earlier.
export function hideRenamedFileWhileOpen(target: string, onClose?: () => void) {
  const original = { open: fsp.open, openSync: fs.openSync, closeSync: fs.closeSync,
    stat: fs.statSync, lstat: fs.lstatSync, fstat: fs.fstatSync,
    rename: fsp.rename, renameSync: fs.renameSync, asyncStat: fsp.stat, asyncLstat: fsp.lstat };
  const descriptors = new Map<number, string>();
  const hidden = new Set<number>();
  let failures = 0;
  let closes = 0;
  let identity: fs.BigIntStats | undefined;
  const missing = () => { failures++; throw Object.assign(new Error("rename hidden while descriptor open"), { code: "ENOENT" }); };
  const checkPath = (pathname: unknown) => { if (String(pathname) === target && hidden.size) missing(); };
  const checkFd = (fd: number) => { if (hidden.has(fd)) missing(); };
  const refersToHiddenIdentity = (fd: number) => {
    if (!identity) return false;
    try {
      const stat = original.fstat(fd, { bigint: true });
      return stat.dev === identity.dev && stat.ino === identity.ino;
    } catch {
      return false;
    }
  };
  const track = (fd: number, pathname: unknown) => {
    descriptors.set(fd, String(pathname));
    // Any new descriptor to the hidden inode (e.g. a metadata pin) extends
    // the hiding on real DrvFS mounts.
    if (identity && hidden.size && refersToHiddenIdentity(fd)) hidden.add(fd);
  };
  const closed = (fd: number) => {
    descriptors.delete(fd);
    if (hidden.delete(fd)) {
      closes++;
      onClose?.();
    }
  };
  const renamed = (from: unknown, to: unknown) => {
    if (String(to) !== target) return;
    for (const [fd, name] of descriptors) {
      if (name === String(from)) {
        identity = original.fstat(fd, { bigint: true });
        hidden.add(fd);
      }
    }
  };
  const trackHandle = (handle: FileHandle, pathname: unknown) => {
    const fd = handle.fd;
    track(fd, pathname);
    const close = handle.close.bind(handle);
    const stat = handle.stat.bind(handle);
    handle.close = async () => { await close(); closed(fd); };
    handle.stat = ((...args: Parameters<FileHandle["stat"]>) => { checkFd(fd); return stat(...args); }) as FileHandle["stat"];
    return handle;
  };
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    checkPath(args[0]);
    return trackHandle(await original.open(...args), args[0]);
  });
  vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    checkPath(args[0]);
    const fd = original.openSync(...args);
    track(fd, args[0]);
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "closeSync").mockImplementation(fd => { original.closeSync(fd); closed(fd); });
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, ...args: unknown[]) => {
    checkFd(fd); return Reflect.apply(original.fstat, fs, [fd, ...args]);
  }) as typeof fs.fstatSync);
  for (const key of ["statSync", "lstatSync"] as const) {
    vi.spyOn(fs, key).mockImplementation(((pathname: unknown, ...args: unknown[]) => {
      checkPath(pathname); return Reflect.apply(key === "statSync" ? original.stat : original.lstat, fs, [pathname, ...args]);
    }) as typeof fs.statSync);
  }
  for (const key of ["stat", "lstat"] as const) {
    vi.spyOn(fsp, key).mockImplementation((async (pathname: unknown, ...args: unknown[]) => {
      checkPath(pathname); return Reflect.apply(key === "stat" ? original.asyncStat : original.asyncLstat, fsp, [pathname, ...args]);
    }) as typeof fsp.stat);
  }
  vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => { await original.rename(from, to); renamed(from, to); });
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { original.renameSync(from, to); renamed(from, to); });
  return {
    checkFd, checkPath, renamed, closed,
    trackFd: (fd: number, pathname: string) => track(fd, pathname),
    get failures() { return failures; },
    get closes() { return closes; },
    get identity() { return identity; },
    get hidden() { return hidden.size; },
  };
}
