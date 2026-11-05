import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import { vi } from "vitest";

// Model DrvFS: every observation of the renamed file fails until its writer
// closes. The directory entry and inode survive; no timer makes it visible.
export function hideRenamedFileUntilClose(target: string, onClose?: () => void) {
  const original = { open: fsp.open, openSync: fs.openSync, closeSync: fs.closeSync,
    stat: fs.statSync, lstat: fs.lstatSync, fstat: fs.fstatSync,
    rename: fsp.rename, renameSync: fs.renameSync, asyncStat: fsp.stat, asyncLstat: fsp.lstat };
  const descriptors = new Map<number, string>();
  const hidden = new Set<number>();
  let failures = 0;
  let closes = 0;
  let identity: fs.BigIntStats | undefined;
  const missing = () => { failures++; throw Object.assign(new Error("rename hidden until close"), { code: "ENOENT" }); };
  const checkPath = (pathname: unknown) => { if (String(pathname) === target && hidden.size) missing(); };
  const checkFd = (fd: number) => { if (hidden.has(fd)) missing(); };
  const closed = (fd: number) => {
    descriptors.delete(fd);
    if (hidden.delete(fd)) { closes++; onClose?.(); }
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
  const track = (handle: FileHandle, pathname: unknown) => {
    const fd = handle.fd;
    descriptors.set(fd, String(pathname));
    const close = handle.close.bind(handle);
    const stat = handle.stat.bind(handle);
    handle.close = async () => { await close(); closed(fd); };
    handle.stat = ((...args: Parameters<FileHandle["stat"]>) => { checkFd(fd); return stat(...args); }) as FileHandle["stat"];
    return handle;
  };
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    checkPath(args[0]);
    return track(await original.open(...args), args[0]);
  });
  vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    checkPath(args[0]);
    const fd = original.openSync(...args);
    descriptors.set(fd, String(args[0]));
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
    trackFd: (fd: number, pathname: string) => descriptors.set(fd, pathname),
    get failures() { return failures; },
    get closes() { return closes; },
    get identity() { return identity; },
    get hidden() { return hidden.size; },
  };
}
