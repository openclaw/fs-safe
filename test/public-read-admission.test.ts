import fsSync, { type Stats, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenedFileRealPathForHandle } from "../src/opened-realpath.js";
import { readLocalFileFromRoots, type ReadLocalFileFromRootsOptions } from "../src/local-roots.js";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
const inode = 9007199254740992n;
function project<T extends Stats | BigIntStats>(stat: T, dev: bigint, ino: bigint): T {
  return Object.assign(stat, { dev: typeof stat.dev === "bigint" ? dev : Number(dev), ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
}
function blockDescriptorAliases(fd: number) {
  const realpath = realpathSync.native;
  vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
    if ([`/proc/self/fd/${fd}`, `/dev/fd/${fd}`].includes(String(candidate))) throw Object.assign(new Error("no fd alias"), { code: "ENOENT" });
    return realpath(candidate);
  });
}

describe("public opened-handle identity admission", () => {
  it.each([false, true])("does not confuse rounded-equal file IDs, replaced=%s", async replaced => {
    const directory = await tempRoot("fs-safe-handle-exact-");
    const filePath = path.join(directory, "file");
    await fs.writeFile(filePath, "original");
    const handle = await fs.open(filePath, "r");
    try {
      await handle.read(Buffer.alloc(1), 0, 1, null);
      if (replaced) {
        const parked = await tempRoot("fs-safe-handle-parked-");
        await fs.rename(filePath, path.join(parked, "original"));
        await fs.writeFile(filePath, "foreign");
      }
      blockDescriptorAliases(handle.fd);
      const fstat = fsSync.fstatSync, stat = fsSync.statSync, lstat = fsSync.lstatSync;
      const descriptorSamples = vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => project(fstat(fd, options as never), 5n, inode));
      const pathSamples = vi.spyOn(fsSync, "statSync").mockImplementation((candidate, options) => {
        const observed = stat(candidate, options as never);
        return String(candidate) === filePath ? project(observed, 5n, inode + (replaced ? 1n : 0n)) : observed;
      });
      vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
        const observed = lstat(candidate, options as never);
        return String(candidate) === filePath ? project(observed, 5n, inode + (replaced ? 1n : 0n)) : observed;
      });
      const pending = resolveOpenedFileRealPathForHandle(handle, filePath);
      if (replaced) await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
      else await expect(pending).resolves.toBe(filePath);
      expect(descriptorSamples).toHaveBeenCalledTimes(1);
      if (!replaced) expect(pathSamples).toHaveBeenCalledTimes(1);
      expect(await handle.readFile("utf8")).toBe("riginal");
    } finally { await handle.close(); }
  });

  it.each([false, true])("strictly samples an unknown borrowed descriptor, recovers=%s", async recovers => {
    const directory = await tempRoot("fs-safe-handle-fstat-");
    const filePath = path.join(directory, "file"); await fs.writeFile(filePath, "bytes");
    const handle = await fs.open(filePath, "r");
    Object.defineProperty(process, "platform", { value: "win32" });
    blockDescriptorAliases(handle.fd);
    const fstat = fsSync.fstatSync, stat = fsSync.statSync;
    let samples = 0, pathSamples = 0;
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => project(fstat(fd, options as never), ++samples === 1 || !recovers ? 0n : 5n, inode));
    vi.spyOn(fsSync, "statSync").mockImplementation((candidate, options) => {
      const observed = stat(candidate, options as never);
      if (String(candidate) !== filePath) return observed;
      pathSamples++; return project(observed, 5n, inode);
    });
    try {
      const pending = resolveOpenedFileRealPathForHandle(handle, filePath);
      if (recovers) await expect(pending).resolves.toBe(filePath);
      else await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
      expect(samples).toBe(2); expect(pathSamples).toBe(recovers ? 1 : 0);
      expect(await handle.readFile("utf8")).toBe("bytes");
    } finally { await handle.close(); }
  });

  it.each(["recovered", "persistent", "alternating"])("strictly reinspects a %s unknown Windows path receipt", async kind => {
    const directory = await tempRoot("fs-safe-handle-unknown-");
    const filePath = path.join(directory, "file"); await fs.writeFile(filePath, "bytes");
    const handle = await fs.open(filePath, "r");
    Object.defineProperty(process, "platform", { value: "win32" });
    blockDescriptorAliases(handle.fd);
    const fstat = fsSync.fstatSync, stat = fsSync.statSync;
    let samples = 0;
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => project(fstat(fd, options as never), 5n, inode));
    vi.spyOn(fsSync, "statSync").mockImplementation((candidate, options) => {
      const observed = stat(candidate, options as never);
      if (String(candidate) !== filePath) return observed;
      samples++;
      return project(observed, samples === 1 || kind === "persistent" ? 0n : 5n, kind === "alternating" && samples === 2 ? 0n : inode);
    });
    try {
      const pending = resolveOpenedFileRealPathForHandle(handle, filePath);
      if (kind === "recovered") await expect(pending).resolves.toBe(filePath);
      else await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
      expect(samples).toBe(2);
      expect(await handle.readFile("utf8")).toBe("bytes");
    } finally { await handle.close(); }
  });
});

describe("local-root read policy snapshot", () => {
  it.each(process.platform === "win32" ? ["hardlink"] as const : ["hardlink", "symlink"] as const)("retains a rejecting %s policy", async kind => {
    const directory = await tempRoot("fs-safe-local-policy-");
    const source = path.join(directory, "source"), filePath = path.join(directory, "selected");
    await fs.writeFile(source, "private bytes");
    if (kind === "hardlink") await fs.link(source, filePath);
    else await fs.symlink(source, filePath);
    const options: ReadLocalFileFromRootsOptions = { roots: [directory], filePath, hardlinks: "reject", symlinks: "reject" };
    const pending = readLocalFileFromRoots(options);
    options.hardlinks = "allow"; options.symlinks = "follow-within-root";
    expect(await pending).toBeNull();
    expect((await readLocalFileFromRoots(options))?.buffer.toString()).toBe("private bytes");
  });

  it("samples inherited policy getters once before root initialization", async () => {
    const directory = await tempRoot("fs-safe-local-getters-");
    const filePath = path.join(directory, "file"); await fs.writeFile(filePath, "bytes");
    let hardlinks = 0, symlinks = 0;
    const options = Object.assign(Object.create({
      get hardlinks() { hardlinks++; expect(this).toBe(options); return "reject"; },
      get symlinks() { symlinks++; expect(this).toBe(options); return "reject"; },
    }), { filePath, roots: [path.join(directory, "absent"), directory] });
    const pending = readLocalFileFromRoots(options);
    expect({ hardlinks, symlinks }).toEqual({ hardlinks: 1, symlinks: 1 });
    expect((await pending)?.buffer.toString()).toBe("bytes");
    expect({ hardlinks, symlinks }).toEqual({ hardlinks: 1, symlinks: 1 });
  });

  it("leaves unused policy getters alone with no configured roots", async () => {
    expect(await readLocalFileFromRoots({ roots: [], filePath: path.resolve("unused"), get hardlinks(): never { throw new Error("unused"); } })).toBeNull();
  });

  it("preserves a configured policy getter failure", async () => {
    const directory = await tempRoot("fs-safe-local-policy-error-");
    const failure = new Error("policy unavailable");
    await expect(readLocalFileFromRoots({ roots: [directory], filePath: path.join(directory, "unused"), get hardlinks(): never { throw failure; } })).rejects.toBe(failure);
  });
});
