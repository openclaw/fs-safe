import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recoverAfterHiddenRename } from "../src/publication-recovery.js";

describe("recoverAfterHiddenRename", () => {
  it("closes the writer before the first reopen attempt", async () => {
    const order: string[] = [];
    await recoverAfterHiddenRename({
      closeWriter: async () => { order.push("close"); },
      reopen: async () => { order.push("reopen"); return "handle"; },
      backoffMs: 0,
    });
    expect(order).toEqual(["close", "reopen"]);
  });

  it("retries bounded ENOENT visibility lag and returns the verified handle", async () => {
    let attempts = 0;
    const handle = await recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("not yet visible"), { code: "ENOENT" });
        return "verified";
      },
      attempts: 5,
      backoffMs: 0,
    });
    expect(handle).toBe("verified");
    expect(attempts).toBe(3);
  });

  it("stops retrying after the attempt budget and rethrows ENOENT", async () => {
    let attempts = 0;
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => { attempts += 1; throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
      attempts: 3,
      backoffMs: 0,
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(attempts).toBe(3);
  });

  it("does not retry non-ENOENT failures", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => { attempts += 1; throw failure; },
      attempts: 5,
      backoffMs: 0,
    })).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("closes the writer even when reopening keeps failing", async () => {
    let closed = false;
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => { closed = true; },
      reopen: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
      attempts: 2,
      backoffMs: 0,
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(closed).toBe(true);
  });

  it("opens the pin before closing the writer and closes it after success", async () => {
    const pinPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-pin-")), "pin");
    await fs.writeFile(pinPath, "pin");
    const order: string[] = [];
    let pinFd = -1;
    const handle = await recoverAfterHiddenRename({
      closeWriter: async () => { order.push("close"); },
      reopen: async () => { order.push("reopen"); return "verified"; },
      openPin: () => {
        pinFd = fsSync.openSync(pinPath, "r");
        order.push("pin");
        return pinFd;
      },
      backoffMs: 0,
    });
    expect(handle).toBe("verified");
    expect(order).toEqual(["pin", "close", "reopen"]);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("releases the pin and retries when the name stays hidden behind it", async () => {
    let pinFd = -1;
    const pinPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-pin-")), "pin");
    await fs.writeFile(pinPath, "pin");
    let attempts = 0;
    const handle = await recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("hidden behind pin"), { code: "ENOENT" });
        return "verified";
      },
      openPin: () => { pinFd = fsSync.openSync(pinPath, "r"); return pinFd; },
      attempts: 5,
      backoffMs: 0,
    });
    expect(handle).toBe("verified");
    expect(attempts).toBe(2);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("releases the pin and rethrows non-ENOENT failures without retrying", async () => {
    let pinFd = -1;
    let attempts = 0;
    const pinPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-pin-")), "pin");
    await fs.writeFile(pinPath, "pin");
    const failure = Object.assign(new Error("identity changed"), { code: "path-mismatch" });
    await expect(recoverAfterHiddenRename({
      closeWriter: async () => undefined,
      reopen: async () => { attempts += 1; throw failure; },
      openPin: () => { pinFd = fsSync.openSync(pinPath, "r"); return pinFd; },
      attempts: 5,
      backoffMs: 0,
    })).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(() => fsSync.fstatSync(pinFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });
});
