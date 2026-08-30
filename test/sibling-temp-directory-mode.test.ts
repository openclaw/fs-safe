import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { replaceFileAtomic } from "../src/atomic.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await tempRoot("fs-safe-sibling-dirmode-");
  const dir = path.join(root, "parent");
  await fs.mkdir(dir);
  await fs.chmod(dir, 0o755);
  const final = path.join(dir, "final");
  await fs.writeFile(final, "old");
  const writeTemp = vi.fn(async (temporary: string) => {
    await fs.writeFile(temporary, "new");
  });
  return { root, dir, final, options: { dir, writeTemp, resolveFinalPath: () => final } };
}

itPosix.each(["EPERM", "EIO"])("tolerates only directory descriptor chmod failure (%s)", async (code) => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  const failure = Object.assign(new Error("directory chmod failed"), { code });
  const directoryChmod = vi.fn().mockRejectedValue(failure);
  const pathnameChmod = vi.spyOn(fs, "chmod").mockRejectedValue(new Error("pathname chmod forbidden"));
  let directory: FileHandle | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.dir) {
      directory = handle;
      vi.spyOn(handle, "chmod").mockImplementation(directoryChmod);
    }
    return handle;
  });
  await writeSiblingTempFile(f.options);
  expect(directoryChmod).toHaveBeenCalledExactlyOnceWith(0o700);
  expect(directory?.fd).toBe(-1);
  expect((await fs.stat(f.dir)).mode & 0o777).toBe(0o755);
  expect(await fs.readFile(f.final, "utf8")).toBe("new");
  expect(pathnameChmod).not.toHaveBeenCalled();
});

itPosix.each(["lstat", "open", "pathname-type", "stat", "descriptor-type", "identity", "close"] as const)(
  "propagates directory %s failure before invoking the producer", async (phase) => {
    const f = await fixture();
    const open = fs.open.bind(fs);
    const failure = Object.assign(new Error(`directory ${phase} failed`), { code: "EIO" });
    const chmod = vi.fn();
    let directory: FileHandle | undefined;
    if (phase === "lstat") vi.spyOn(fs, "lstat").mockRejectedValueOnce(failure);
    if (phase === "pathname-type") vi.spyOn(fs, "lstat").mockResolvedValueOnce(await fs.stat(f.final));
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] !== f.dir) return await open(...args);
      if (phase === "open") throw failure;
      if (phase === "identity") {
        await fs.rename(f.dir, path.join(f.root, "moved"));
        await fs.mkdir(f.dir);
        await fs.writeFile(path.join(f.dir, "sentinel"), "keep");
      }
      directory = phase === "descriptor-type" ? await open(f.final, "r") : await open(...args);
      vi.spyOn(directory, "chmod").mockImplementation(async () => {
        chmod();
        throw new Error("directory chmod denied");
      });
      if (phase === "stat") vi.spyOn(directory, "stat").mockRejectedValue(failure);
      if (phase === "close") {
        const close = directory.close.bind(directory);
        vi.spyOn(directory, "close").mockImplementation(async () => {
          await close();
          throw failure;
        });
      }
      return directory;
    });
    const operation = writeSiblingTempFile(f.options);
    if (phase === "identity") await expect(operation).rejects.toMatchObject({ code: "path-mismatch" });
    else if (phase.endsWith("type")) await expect(operation).rejects.toMatchObject({ code: "not-file" });
    else await expect(operation).rejects.toBe(failure);
    expect(f.options.writeTemp).not.toHaveBeenCalled();
    if (directory) expect(directory.fd).toBe(-1);
    expect(chmod).toHaveBeenCalledTimes(phase === "close" ? 1 : 0);
    if (phase === "identity") {
      expect(await fs.readFile(path.join(f.dir, "sentinel"), "utf8")).toBe("keep");
      expect(await fs.readFile(path.join(f.root, "moved", "final"), "utf8")).toBe("old");
    } else expect(await fs.readFile(f.final, "utf8")).toBe("old");
  },
);

itPosix("tolerates explicit staged-file mode errors after directory chmod", async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  const fileFailure = new Error("staged chmod failed");
  const directoryChmod = vi.fn().mockRejectedValue(new Error("directory chmod failed"));
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.dir) vi.spyOn(handle, "chmod").mockImplementation(directoryChmod);
    else vi.spyOn(handle, "chmod").mockRejectedValue(fileFailure);
    return handle;
  });
  await writeSiblingTempFile({ ...f.options, mode: 0o600 });
  expect(directoryChmod).toHaveBeenCalledOnce();
  expect(f.options.writeTemp).toHaveBeenCalledOnce();
  expect(await fs.readFile(f.final, "utf8")).toBe("new");
  expect(await fs.readdir(f.dir)).toEqual(["final"]);
});

itPosix("keeps other directory-mode callers strict by default", async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  const failure = new Error("directory chmod failed");
  let directory: FileHandle | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.dir) {
      directory = handle;
      vi.spyOn(handle, "chmod").mockRejectedValue(failure);
    }
    return handle;
  });
  await expect(replaceFileAtomic({ filePath: f.final, content: "new", dirMode: 0o700 })).rejects.toBe(failure);
  expect(directory?.fd).toBe(-1);
  expect(await fs.readFile(f.final, "utf8")).toBe("old");
});
