import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { replaceFileAtomic } from "../src/atomic.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { hideRenamedFileWhileOpen } from "./helpers/rename-hidden.js";
import { useRealTempDirs } from "./helpers/vitest.js";
const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __setFsSafeTestHooksForTest(undefined); });
it.skipIf(process.platform === "win32").each([true, false])("verifies the actual destination mount for literal symlink/.. paths (%s)", async verifiedDestination => {
  const directory = await tempRoot("drvfs-parent-");
  const staging = path.join(directory, "staging");
  const destination = path.join(directory, "destination");
  await fsp.mkdir(staging);
  await fsp.mkdir(path.join(destination, "child"), { recursive: true });
  await fsp.symlink(path.join(destination, "child"), path.join(staging, "link"));
  const filePath = `${staging}/link/../target`;
  const expectedParent = fs.statSync(destination, { bigint: true });
  const sourceParent = fs.statSync(staging, { bigint: true });
  const fault = hideRenamedFileWhileOpen(filePath);
  __setFsSafeTestHooksForTest({ drvfsMountObservation: fd => {
    const retained = fs.fstatSync(fd, { bigint: true });
    const allowed = verifiedDestination ? expectedParent : sourceParent;
    return retained.dev === allowed.dev && retained.ino === allowed.ino
      ? { magic: 0x01021997n, fdinfo: "mnt_id:\t51\n", mountinfo: "51 1 0:69 / /target rw - 9p C: rw,aname=drvfs;metadata" }
      : undefined;
  } });
  const operation = replaceFileAtomic({ filePath, content: "payload", allowDrvfsRenameRecovery: true });
  if (verifiedDestination) await operation;
  else await expect(operation).rejects.toBeTruthy();
  expect(fault.failures).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(destination, "target"), "utf8")).toBe("payload");
});
