import { afterEach, expect, it, vi } from "vitest";
import { admitsDrvfsRenameRecoveryAtFd, recoverAfterHiddenRename, recoverAfterHiddenRenameSync } from "../src/publication-recovery.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
const mount = { magic: 0x01021997n, fdinfo: "pos:\t0\nmnt_id:\t51\n", mountinfo: "51 1 0:69 /sub /container/state rw - 9p D: rw,aname=drvfs;path=D:;metadata,cache=5" };
afterEach(() => __setFsSafeTestHooksForTest(undefined));
it("admits the reporter's Docker bind mount by exact mount ID, without caching", () => {
  let observation: typeof mount | undefined = mount;
  __setFsSafeTestHooksForTest({ drvfsMountObservation: () => observation });
  expect(admitsDrvfsRenameRecoveryAtFd(42)).toBe(true);
  observation = undefined;
  expect(admitsDrvfsRenameRecoveryAtFd(42)).toBe(false);
});
it.each([
  { ...mount, magic: 0xef53n },
  { ...mount, fdinfo: "mnt_id:\t52\n" },
  { ...mount, fdinfo: "mnt_id:\t51\nmnt_id:\t52\n" },
  { ...mount, mountinfo: mount.mountinfo.replace(" - 9p ", " - overlay ") },
  { ...mount, mountinfo: mount.mountinfo.replace("aname=drvfs", "aname=other") },
  { ...mount, mountinfo: mount.mountinfo.replace("aname=drvfs", "aname=drvfs-fake") },
  { ...mount, mountinfo: mount.mountinfo.replace(" rw - ", " rw,aname=drvfs - ").replace("aname=drvfs;", "aname=other;") },
  { ...mount, mountinfo: `${mount.mountinfo}\n${mount.mountinfo}` },
])("rejects incomplete or unrelated mount evidence %#", observation => {
  __setFsSafeTestHooksForTest({ drvfsMountObservation: () => observation });
  expect(admitsDrvfsRenameRecoveryAtFd(42)).toBe(false);
});
it("does not close the writer when verification is unavailable", async () => {
  const closeWriter = vi.fn(async () => {});
  __setFsSafeTestHooksForTest({ drvfsMountObservation: () => undefined });
  await expect(recoverAfterHiddenRename({ parentFd: 42, closeWriter, reopen: async () => {} })).rejects.toBeTruthy();
  expect(closeWriter).not.toHaveBeenCalled();
});
for (const sync of [false, true]) {
  it(`bounds ENOENT retries after close (${sync})`, async () => {
    __setFsSafeTestHooksForTest({ drvfsMountObservation: () => mount });
    let calls = 0;
    const fail = () => { calls++; throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    if (sync) expect(() => recoverAfterHiddenRenameSync({ parentFd: 42, closeWriter() {}, reopen: fail })).toThrow();
    else await expect(recoverAfterHiddenRename({ parentFd: 42, closeWriter: async () => {}, reopen: async () => fail() })).rejects.toThrow();
    expect(calls).toBe(5);
  });
}
it("reads the retained descriptor's exact mount, never the procfs link device", async () => {
  const fs = (await import("node:fs")).default;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  const statfs = vi.spyOn(fs, "statfsSync").mockImplementation(((name: string) => ({ type: name === "/proc/self/fd" ? 0x9fa0n : 0x01021997n })) as typeof fs.statfsSync);
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(((name: string) => name === "/proc/self/mountinfo" ? mount.mountinfo : name === "/proc/self/fdinfo/42" ? mount.fdinfo : "mnt_id:\t52\n") as typeof fs.readFileSync);
  try {
    expect(admitsDrvfsRenameRecoveryAtFd(42)).toBe(true);
    expect(admitsDrvfsRenameRecoveryAtFd(43)).toBe(false);
    expect(statfs.mock.calls.map(call => call[0])).toContain("/proc/self/fd/42");
    expect(read.mock.calls.map(call => call[0])).toContain("/proc/self/fdinfo/42");
  } finally {
    statfs.mockRestore(); read.mockRestore();
    Object.defineProperty(process, "platform", platform);
  }
});
it("never prepares DrvFS recovery on a non-Linux platform without a test seam", async () => {
  const { shouldPrepareDrvfsRecovery } = await import("../src/publication-recovery.js");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const value of ["win32", "darwin", "freebsd"]) {
      Object.defineProperty(process, "platform", { value });
      expect(shouldPrepareDrvfsRecovery(true)).toBe(false);
    }
  } finally { Object.defineProperty(process, "platform", platform); }
});
