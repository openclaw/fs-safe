import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitsUnpinnedRenameRecovery, recoverAfterHiddenRename, recoverAfterHiddenRenameSync } from "../src/publication-recovery.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

const enoent = () => Object.assign(new Error("not visible"), { code: "ENOENT" });

async function makePinFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-pin-"));
  const pinPath = path.join(dir, "pin");
  await fs.writeFile(pinPath, "pin");
  return pinPath;
}

describe("recoverAfterHiddenRename", () => {
  it("retains the pin through settlement and closes it afterwards", async () => {
    const pinPath = await makePinFile();
    let pinFd = -1;
    let pinValidAtSettlement = false;
    await recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => "verified",
      openPin: () => { pinFd = fsSync.openSync(pinPath, "r"); return pinFd; },
      retain: async () => {
        try {
          fsSync.fstatSync(pinFd);
          pinValidAtSettlement = true;
        } catch { /* closed early */ }
      },
    });
    expect(pinValidAtSettlement).toBe(true);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("fails closed on ENOENT when the filesystem is not admitted", async () => {
    const pinPath = await makePinFile();
    let pinFd = -1;
    let reopens = 0;
    __setFsSafeTestHooksForTest({ admitUnpinnedRenameRecovery: () => false });
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => { reopens += 1; throw enoent(); },
      openPin: () => { pinFd = fsSync.openSync(pinPath, "r"); return pinFd; },
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(reopens).toBe(1);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("releases the pin and retries only when the filesystem is admitted", async () => {
    const pinPath = await makePinFile();
    let pinFd = -1;
    let reopens = 0;
    __setFsSafeTestHooksForTest({ admitUnpinnedRenameRecovery: () => true });
    const handle = await recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => {
        reopens += 1;
        if (reopens === 1) throw enoent();
        return "verified";
      },
      openPin: () => { pinFd = fsSync.openSync(pinPath, "r"); return pinFd; },
      admitUnpinned: () => admitsUnpinnedRenameRecovery(os.tmpdir()),
      backoffMs: 0,
    });
    expect(handle).toBe("verified");
    expect(reopens).toBe(2);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("does not admit unpinned recovery for non-ENOENT failures", async () => {
    const pinPath = await makePinFile();
    let pinFd = -1;
    __setFsSafeTestHooksForTest({ admitUnpinnedRenameRecovery: () => true });
    const mismatch = Object.assign(new Error("identity changed"), { code: "path-mismatch" });
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => { throw mismatch; },
      openPin: () => { pinFd = fsSync.openSync(pinPath, "r"); return pinFd; },
    })).rejects.toBe(mismatch);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("closes the pin when the writer close rejects", async () => {
    const pinPath = await makePinFile();
    let pinFd = -1;
    const closeFailure = Object.assign(new Error("close failed"), { code: "EIO" });
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => { throw closeFailure; },
      reopen: async () => "unused",
      openPin: () => { pinFd = fsSync.openSync(pinPath, "r"); return pinFd; },
    })).rejects.toBe(closeFailure);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("propagates pin acquisition failures without reopening", async () => {
    let reopens = 0;
    const unavailable = Object.assign(new Error("no pin support"), { code: "helper-unavailable" });
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => { reopens += 1; return "unused"; },
      openPin: () => { throw unavailable; },
    })).rejects.toBe(unavailable);
    expect(reopens).toBe(0);
  });

  it("stops retrying after the admitted attempt budget", async () => {
    let reopens = 0;
    __setFsSafeTestHooksForTest({ admitUnpinnedRenameRecovery: () => true });
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => { reopens += 1; throw enoent(); },
      admitUnpinned: () => admitsUnpinnedRenameRecovery(os.tmpdir()),
      attempts: 3,
      backoffMs: 0,
    })).rejects.toMatchObject({ code: "ENOENT" });
    // One pinned attempt plus the three-attempt admitted budget.
    expect(reopens).toBe(4);
  });
});

describe("recoverAfterHiddenRenameSync", () => {
  it("retains the pin through settlement and fails closed without admission", () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "fs-safe-pin-"));
    const pinPath = path.join(dir, "pin");
    fsSync.writeFileSync(pinPath, "pin");
    let pinFd = -1;
    let pinValidAtSettlement = false;
    recoverAfterHiddenRenameSync({
      closeWriter: () => undefined,
      reopen: () => "verified",
      openPin: () => { pinFd = fsSync.openSync(pinPath, "r"); return pinFd; },
      retain: () => {
        try {
          fsSync.fstatSync(pinFd);
          pinValidAtSettlement = true;
        } catch { /* closed early */ }
      },
    });
    expect(pinValidAtSettlement).toBe(true);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));

    let pinFd2 = -1;
    expect(() => recoverAfterHiddenRenameSync({
      closeWriter: () => undefined,
      reopen: () => { throw enoent(); },
      openPin: () => { pinFd2 = fsSync.openSync(pinPath, "r"); return pinFd2; },
    })).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => fsSync.fstatSync(pinFd2)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });
});

describe("admitsUnpinnedRenameRecovery", () => {
  it("rejects admission when statfs cannot be observed", () => {
    expect(admitsUnpinnedRenameRecovery(path.join(os.tmpdir(), "does-not-exist-xyz"))).toBe(false);
  });
});
