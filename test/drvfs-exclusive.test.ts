import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { hideRenamedFileWhileOpen } from "./helpers/rename-hidden.js";
import { useRealTempDirs } from "./helpers/vitest.js";
const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); __setFsSafeTestHooksForTest(undefined); });
it.skipIf(process.platform === "win32").each(["original", "off", "swap", "delete"])("verifies exclusive placeholder publication without hardlinks: %s", async kind => {
  const directory = await tempRoot("drvfs-exclusive-");
  const target = path.join(directory, "target");
  configureFsSafeNative({ mode: "off" });
  const safe = await root(directory);
  const fault = hideRenamedFileWhileOpen(target, () => {
    if (kind === "swap" || kind === "delete") {
      fs.unlinkSync(target);
      if (kind === "swap") fs.writeFileSync(target, "foreign", { mode: 0o600 });
    }
  });
  vi.spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("unsupported"), { code: "EPERM" }); });
  __setFsSafeTestHooksForTest({ drvfsMountObservation: () => ({ magic: 0x01021997n,
    fdinfo: "mnt_id:\t51\n", mountinfo: "51 1 0:69 / /mnt/c rw - 9p C: rw,aname=drvfs;metadata" }) });
  const operation = safe.create("target", "payload", { atomic: true, allowDrvfsRenameRecovery: kind !== "off" });
  if (kind === "original") await operation;
  else await expect(operation).rejects.toBeTruthy();
  expect(fault.failures).toBeGreaterThan(0);
  expect(fault.closes).toBe(1);
  if (kind === "original" || kind === "off") expect(fs.readFileSync(target, "utf8")).toBe("payload");
});
