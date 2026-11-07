import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { hideRenamedFileWhileOpen } from "./helpers/rename-hidden.js";
import { useRealTempDirs } from "./helpers/vitest.js";
const { tempRoot } = useRealTempDirs();
export const drvfsMount = { magic: 0x01021997n, fdinfo: "pos:\t0\nmnt_id:\t51\n", mountinfo: "51 1 0:69 / /mnt/c rw - 9p C: rw,aname=drvfs;path=C:;metadata,cache=5" };
afterEach(() => { vi.restoreAllMocks(); __setFsSafeTestHooksForTest(undefined); });
for (const sync of [false, true]) {
  for (const kind of ["success", "off", "non-drvfs", "unverifiable", "plain-9p", "swap", "delete", "owner", "content"] as const) {
    it.skipIf(process.platform === "win32")(`${sync ? "sync" : "async"}: ${kind}`, async () => {
      const filePath = path.join(await tempRoot("drvfs-opt-in-"), "target");
      const originalFstat = fs.fstatSync;
      const fault = hideRenamedFileWhileOpen(filePath, () => {
        if (kind === "swap" || kind === "delete") {
          fs.unlinkSync(filePath);
          if (kind === "swap") fs.writeFileSync(filePath, "foreign");
        }
        if (kind === "content") fs.writeFileSync(filePath, "changed");
      });

      if (kind === "owner") vi.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
        fault.checkFd(args[0]);
        const stat = Reflect.apply(originalFstat, fs, args);
        if (fault.closes) Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1 });
        return stat;
      }) as typeof fs.fstatSync);
      __setFsSafeTestHooksForTest({ drvfsMountObservation: () => kind === "unverifiable" ? undefined : {
        ...drvfsMount,
        magic: kind === "non-drvfs" ? 0xef53n : drvfsMount.magic,
        mountinfo: kind === "plain-9p" ? drvfsMount.mountinfo.replace("aname=drvfs", "aname=other") : drvfsMount.mountinfo,
      } });
      const operation = Promise.resolve().then(() => (sync ? replaceFileAtomicSync : replaceFileAtomic)({
        filePath, content: "payload", allowDrvfsRenameRecovery: kind !== "off",
      }));
      if (kind === "success") {
        await operation;
        expect(fs.readFileSync(filePath, "utf8")).toBe("payload");
        expect(fault.closes).toBe(1);
      } else await expect(operation).rejects.toBeTruthy();
      expect(fault.failures).toBeGreaterThan(0);
      expect(fault.hidden).toBe(0);
    });
  }
}
it("does not inspect mounts for healthy publications, including opt-in writes", async () => {
  const directory = await tempRoot("drvfs-healthy-");
  const statfs = vi.spyOn(fs, "statfsSync");
  for (const allowDrvfsRenameRecovery of [undefined, false, true]) {
    await replaceFileAtomic({ filePath: path.join(directory, "async"), content: "payload", allowDrvfsRenameRecovery });
    replaceFileAtomicSync({ filePath: path.join(directory, "sync"), content: "payload", allowDrvfsRenameRecovery });
  }
  expect(statfs).not.toHaveBeenCalled();
});
