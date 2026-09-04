import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendRegularFile, appendRegularFileSync } from "../src/regular-file.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());
const append = async (kind: string, options: Parameters<typeof appendRegularFile>[0]) => {
  if (kind === "async") await appendRegularFile(options);
  else appendRegularFileSync(options);
};

describe.skipIf(process.platform === "win32")("regular append final file mode", () => {
  it.each(["async", "sync"].flatMap((kind) => ["", "added"].flatMap((content) =>
    [0o600, 0o4600].map((mode) => ({ kind, content, mode })),
  )))("$kind append '$content' preserves explicit mode $mode", async ({ kind, content, mode }) => {
    const directory = await tempRoot("fs-safe-append-mode-");
    const filePath = path.join(directory, "target");
    await fs.writeFile(filePath, "initial", { mode: 0o600 });
    await fs.chown(filePath, process.geteuid!(), process.getegid!());
    await append(kind, { filePath, content, mode });
    expect((await fs.stat(filePath)).mode & 0o7777).toBe(mode);
    expect(await fs.readFile(filePath, "utf8")).toBe(`initial${content}`);
  });

  it.each(["async", "sync"])("%s tightens existing permissions before appending", async (kind) => {
    const directory = await tempRoot("fs-safe-append-private-first-");
    const filePath = path.join(directory, "target");
    await fs.writeFile(filePath, "initial", { mode: 0o644 });
    await fs.chmod(filePath, 0o644);
    let observed = false;
    if (kind === "async") {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        const appendFile = handle.appendFile.bind(handle);
        vi.spyOn(handle, "appendFile").mockImplementation(async (...args) => {
          expect((await handle.stat()).mode & 0o7777).toBe(0o600);
          observed = true;
          await appendFile(...args);
        });
        return handle;
      });
    } else {
      const write = fsSync.writeSync.bind(fsSync);
      vi.spyOn(fsSync, "writeSync").mockImplementation(((...args: Parameters<typeof fsSync.writeSync>) => {
        expect(fsSync.fstatSync(args[0]).mode & 0o7777).toBe(0o600);
        observed = true;
        return write(...args);
      }) as typeof fsSync.writeSync);
    }
    await append(kind, { filePath, content: "private", mode: 0o600 });
    expect(observed).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("initialprivate");
  });

  it.each(["async", "sync"])("%s does not append when initial mode tightening fails", async (kind) => {
    const directory = await tempRoot("fs-safe-append-mode-refusal-");
    const filePath = path.join(directory, "target");
    await fs.writeFile(filePath, "initial", { mode: 0o644 });
    const failure = Object.assign(new Error("mode denied"), { code: "EIO" });
    if (kind === "async") {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        vi.spyOn(handle, "chmod").mockRejectedValue(failure);
        return handle;
      });
    } else {
      vi.spyOn(fsSync, "fchmodSync").mockImplementation(() => { throw failure; });
    }
    await expect(append(kind, { filePath, content: "private", mode: 0o600 })).rejects.toBe(failure);
    expect(await fs.readFile(filePath, "utf8")).toBe("initial");
  });
  it.each(["async", "sync"])("%s closes after final chmod failure without rolling back bytes", async (kind) => {
    const directory = await tempRoot("fs-safe-append-final-mode-refusal-");
    const filePath = path.join(directory, "target");
    await fs.writeFile(filePath, "initial", { mode: 0o600 });
    const failure = Object.assign(new Error("final mode denied"), { code: "EIO" });
    let openedFd = -1;
    let chmodCalls = 0;
    if (kind === "async") {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        openedFd = handle.fd;
        const chmod = handle.chmod.bind(handle);
        vi.spyOn(handle, "chmod").mockImplementation(async (mode) => {
          if (++chmodCalls === 2) throw failure;
          await chmod(mode);
        });
        return handle;
      });
    } else {
      const chmod = fsSync.fchmodSync.bind(fsSync);
      vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
        openedFd = fd;
        if (++chmodCalls === 2) throw failure;
        chmod(fd, mode);
      });
    }
    await expect(append(kind, { filePath, content: "added", mode: 0o4600 })).rejects.toBe(failure);
    expect(chmodCalls).toBe(2);
    expect(() => fsSync.fstatSync(openedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(await fs.readFile(filePath, "utf8")).toBe("initialadded");
  });
});

it("completes short synchronous writes before finalizing an append", async () => {
  const directory = await tempRoot("fs-safe-append-short-write-");
  const filePath = path.join(directory, "target");
  await fs.writeFile(filePath, "initial", { mode: 0o600 });
  const write = fsSync.writeSync.bind(fsSync);
  const calls = vi.spyOn(fsSync, "writeSync").mockImplementation(((
    fd: number, buffer: Uint8Array, offset: number, length: number, position?: number | null,
  ) => write(fd, buffer, offset, Math.min(2, length), position)) as typeof fsSync.writeSync);
  appendRegularFileSync({ filePath, content: "abcdef", mode: 0o600 });
  expect(await fs.readFile(filePath, "utf8")).toBe("initialabcdef");
  expect(calls).toHaveBeenCalledTimes(3);
});
