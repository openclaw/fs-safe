import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinNodeDirectoryForMode } from "../src/directory-mode-node.js";
import { withExtractionDeadline } from "../src/archive-deadline.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const restoreModes: string[] = [];
const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", architecture);
  for (const dir of restoreModes.splice(0)) await fs.chmod(dir, 0o700).catch(() => undefined);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// These are mocked Linux namespace/dispatch tests using a real owned directory fd.
// The parent separately runs the actual non-root Linux O_PATH/procfs syscall proof.
async function simulatedProcRoute() {
  const dir = await tempRoot("fs-safe-mocked-proc-");
  const target = path.join(dir, "target");
  await fs.mkdir(target, { mode: 0o700 });
  restoreModes.push(target);
  const handle = await fs.open(target, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
  const fd = handle.fd;
  await handle.chmod(0o300);
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.defineProperty(process, "arch", { value: "x64" });
  const realOpen = fs.open.bind(fs);
  const open = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
    if (candidate !== target) return await realOpen(candidate, flags, mode);
    if (typeof flags === "number" && flags & 0x200000) return handle;
    throw Object.assign(new Error("mocked read denial"), { code: "EACCES" });
  });
  const namespace = vi.spyOn(fs, "statfs").mockImplementation(async (candidate) => {
    expect(candidate).toBe("/proc/self/fd");
    return { type: 0x9fa0n } as Awaited<ReturnType<typeof fs.statfs>>;
  });
  const procPath = `/proc/self/fd/${fd}`;
  const realStat = fs.stat.bind(fs);
  vi.spyOn(fs, "stat").mockImplementation((async (candidate: fsSync.PathLike, options?: { bigint?: boolean }) => {
    if (candidate === procPath) return await handle.stat({ bigint: true });
    return await realStat(candidate, options as { bigint: true });
  }) as typeof fs.stat);
  const realChmod = fs.chmod.bind(fs);
  const dispatch = vi.spyOn(fs, "chmod").mockImplementation(async (candidate, mode) => {
    if (candidate === procPath) await handle.chmod(mode);
    else await realChmod(candidate, mode);
  });
  const owner = await pinNodeDirectoryForMode(target);
  return { dir, target, handle, fd, owner, namespace, dispatch, procPath, open };
}

describe.skipIf(process.platform === "win32")("mocked Linux directory proc-fd authority", () => {
  it.each(["preflight", "verification"] as const)("joins timeout during procfs %s without releasing the fd", async (phase) => {
    const fixture = await simulatedProcRoute();
    const entered = deferred();
    const expired = deferred();
    const release = deferred();
    let calls = 0;
    fixture.namespace.mockImplementation(async () => {
      if (++calls === (phase === "preflight" ? 1 : 2)) {
        entered.resolve();
        await release.promise;
      }
      return { type: 0x9fa0n } as Awaited<ReturnType<typeof fs.statfs>>;
    });
    const close = vi.spyOn(fixture.handle, "close");
    let settled = false;
    const operation = withExtractionDeadline(300, "proc chmod", async (deadline) => {
      deadline.signal.addEventListener("abort", expired.resolve, { once: true });
      await deadline.ownDestinationMutation(async () => {
        try { await fixture.owner.apply(0o755, { check: deadline.check }); }
        finally { await fixture.owner.close(); }
      });
    });
    void operation.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise;
      await expired.promise;
      expect(settled).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(fsSync.fstatSync(fixture.fd).isDirectory()).toBe(true);
    } finally { release.resolve(); }
    await expect(operation).rejects.toThrow("proc chmod timed out");
    expect(close).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledTimes(phase === "preflight" ? 0 : 1);
    expect((await fs.stat(fixture.target)).mode & 0o777).toBe(phase === "preflight" ? 0o300 : 0o755);
  });

  it.each(["unavailable", "untrusted"] as const)("rejects %s procfs without mutating", async (condition) => {
    const fixture = await simulatedProcRoute();
    if (condition === "unavailable") fixture.namespace.mockRejectedValue(Object.assign(new Error("missing procfs"), { code: "ENOENT" }));
    else fixture.namespace.mockResolvedValue({ type: 0x1234n } as Awaited<ReturnType<typeof fs.statfs>>);
    try {
      await expect(fixture.owner.apply(0o755)).rejects.toThrow(condition === "unavailable" ? "missing procfs" : "trusted procfs");
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect((await fixture.handle.stat()).mode & 0o777).toBe(0o300);
    } finally { await fixture.owner.close(); }
  });

  it("does not require procfs when the requested owned mode already matches", async () => {
    const fixture = await simulatedProcRoute();
    fixture.namespace.mockRejectedValue(new Error("no procfs"));
    try {
      await fixture.owner.apply(0o300);
      expect(fixture.namespace).not.toHaveBeenCalled();
      expect(fixture.dispatch).not.toHaveBeenCalled();
    } finally { await fixture.owner.close(); }
  });

  it("authenticates the exact followed fd identity before dispatch", async () => {
    const fixture = await simulatedProcRoute();
    const wrong = await fs.stat(fixture.dir, { bigint: true });
    vi.mocked(fs.stat).mockResolvedValue(wrong);
    try {
      await expect(fixture.owner.apply(0o755)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(fixture.dispatch).not.toHaveBeenCalled();
    } finally { await fixture.owner.close(); }
  });

  it("holds the descriptor through queued proc chmod and post-operation verification", async () => {
    const fixture = await simulatedProcRoute();
    const entered = deferred();
    const release = deferred();
    const realClose = fixture.handle.close.bind(fixture.handle);
    const close = vi.spyOn(fixture.handle, "close").mockImplementation(realClose);
    fixture.dispatch.mockImplementation(async (candidate, mode) => {
      expect(candidate).toBe(fixture.procPath);
      entered.resolve();
      await release.promise;
      expect(fsSync.fstatSync(fixture.fd).isDirectory()).toBe(true);
      await fixture.handle.chmod(mode);
    });
    const apply = fixture.owner.apply(0o555);
    await entered.promise;
    const closing = fixture.owner.close();
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    await apply;
    await closing;
    await fixture.owner.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(fixture.namespace).toHaveBeenCalledTimes(2);
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(fixture.procPath, 0o555);
    expect(fixture.open).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    expect((await fs.stat(fixture.target)).mode & 0o777).toBe(0o555);
    await fs.chmod(fixture.target, 0o700);
  });

  it("preserves a substitution while an active fd chmod finishes on the original", async () => {
    const fixture = await simulatedProcRoute();
    const moved = path.join(fixture.dir, "moved");
    fixture.dispatch.mockImplementation(async (candidate, mode) => {
      expect(candidate).toBe(fixture.procPath);
      await fs.rename(fixture.target, moved);
      await fs.mkdir(fixture.target, { mode: 0o750 });
      await fixture.handle.chmod(mode);
    });
    try {
      await expect(fixture.owner.apply(0o555)).rejects.toMatchObject({ code: "path-mismatch" });
      expect((await fixture.handle.stat()).mode & 0o777).toBe(0o555);
      expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    } finally { await fixture.owner.close(); }
    vi.restoreAllMocks();
    expect((await fs.stat(fixture.target)).mode & 0o777).toBe(0o750);
    expect((await fs.stat(moved)).mode & 0o777).toBe(0o555);
    await fs.chmod(moved, 0o700);
  });
});
