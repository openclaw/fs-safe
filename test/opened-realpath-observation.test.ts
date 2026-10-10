import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenedFileRealPathForFd } from "../src/opened-realpath.js";
import { realpathSync } from "../src/realpath.js";
import { readLocalFileSafely, root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __setFsSafeTestHooksForTest();
});

describe("opened realpath observations", () => {
  it.each(["darwin", "freebsd", "linux"])("uses only supported descriptor aliases on %s", async (host) => {
    const directory = await tempRoot("fs-safe-realpath-probe-");
    const target = path.join(directory, "target");
    await fs.writeFile(target, "payload");
    const handle = await fs.open(target, "r");
    try {
      const identity = await handle.stat({ bigint: true });
      const realpath = realpathSync.native;
      const calls: string[] = [];
      vi.spyOn(fsSync, "readlinkSync").mockImplementation((target) => {
        calls.push(String(target));
        throw Object.assign(new Error("no procfs"), { code: "ENOENT" });
      });
      vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
        const candidate = String(args[0]);
        calls.push(candidate);
        if (candidate.startsWith("/proc/self/fd/")) throw Object.assign(new Error("no procfs"), { code: "ENOENT" });
        if (candidate.startsWith("/dev/fd/")) return target;
        return realpath(...args);
      });
      const stat = vi.spyOn(fsSync, "statSync");
      Object.defineProperty(process, "platform", { value: host });
      const resolved = await resolveOpenedFileRealPathForFd(handle.fd, identity, target);
      expect(resolved).toMatchObject({ realPath: target, stat: { dev: identity.dev, ino: identity.ino } });
      expect(calls).toEqual(host === "linux" ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`] : [target]);
      expect(stat).toHaveBeenCalledExactlyOnceWith(target, { bigint: true });
    } finally {
      await handle.close();
    }
  });

  it("takes a fresh identity observation after resolving a parent-scan candidate", async () => {
    const directory = await tempRoot("fs-safe-realpath-scan-");
    const target = path.join(directory, "target");
    await fs.writeFile(target, "original");
    const handle = await fs.open(target, "r");
    try {
      const identity = await handle.stat({ bigint: true });
      const realpath = realpathSync.native;
      let attempts = 0;
      vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
        if (String(args[0]) === target) {
          if (++attempts === 1) throw Object.assign(new Error("raced lookup"), { code: "ENOENT" });
          fsSync.renameSync(target, path.join(directory, "saved"));
          fsSync.writeFileSync(target, "replacement");
        }
        return realpath(...args);
      });
      Object.defineProperty(process, "platform", { value: "darwin" });
      await expect(resolveOpenedFileRealPathForFd(handle.fd, identity, target)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(attempts).toBe(2);
    } finally {
      await handle.close();
    }
  });

  it.each(["stable", "hardlink", "windows retry"])("preserves generic opened-file admission: %s", async (scenario) => {
    const directory = await tempRoot("fs-safe-realpath-read-");
    const safe = await root(directory);
    const target = path.join(safe.rootReal, "target");
    await fs.writeFile(target, "payload");
    Object.defineProperty(process, "platform", { value: scenario === "windows retry" ? "win32" : "darwin" });
    let resolving = false;
    let observations = 0;
    __setFsSafeTestHooksForTest({
      async afterOpenedPathIdentityCheck() {
        resolving = true;
        if (scenario === "hardlink") await fs.link(target, path.join(directory, "alias"));
      },
    });
    const stat = fsSync.statSync.bind(fsSync);
    vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
      const observed = stat(...args);
      if (resolving && String(args[0]) === target && args[1]?.bigint) {
        observations++;
        if (scenario === "windows retry" && observations === 1) observed.ino = 0n;
      }
      return observed;
    });
    const pending = scenario === "hardlink"
      ? safe.copyIn("copy", target, { sourceHardlinks: "reject" })
      : readLocalFileSafely({ filePath: target }).then(result => result.buffer.toString());
    if (scenario === "hardlink") await expect(pending).rejects.toMatchObject({ code: "hardlink" });
    else await expect(pending).resolves.toBe("payload");
    expect(observations).toBe(scenario === "windows retry" ? 2 : 1);
  });

  it.each(["standalone", "copy"])("%s rejects a pathname replacement after descriptor acquisition", async (caller) => {
    const directory = await tempRoot("fs-safe-generic-admission-replacement-");
    const safe = await root(directory);
    const target = path.join(safe.rootReal, "target");
    await fs.writeFile(target, "original");
    let close: ReturnType<typeof vi.spyOn> | undefined;
    let read: ReturnType<typeof vi.spyOn> | undefined;
    const resolverHook = vi.fn();
    __setFsSafeTestHooksForTest({
      async afterOpen(candidate, handle) {
        if (candidate !== target) return;
        close = vi.spyOn(handle, "close");
        read = vi.spyOn(handle, "read");
        await fs.rename(target, `${target}.saved`);
        await fs.writeFile(target, "replacement");
      },
      afterOpenedPathIdentityCheck: resolverHook,
    });

    const pending = caller === "copy"
      ? safe.copyIn("copy", target)
      : readLocalFileSafely({ filePath: target });
    await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(resolverHook).not.toHaveBeenCalled();
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(`${target}.saved`, "utf8")).resolves.toBe("original");
    await expect(fs.lstat(path.join(directory, "copy"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
