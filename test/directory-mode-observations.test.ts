import { describe, expect, it, vi } from "vitest";
import { ownDirectoryMode } from "../src/directory-mode-owner.js";

describe("directory mode owner observations", () => {
  it("inspects an unchanged mode once and keeps verify independent", async () => {
    const inspect = vi.fn(async () => 0o700);
    const chmod = vi.fn(async () => undefined);
    const prepareChmod = vi.fn(async () => undefined);
    const owner = ownDirectoryMode({ inspect, chmod, prepareChmod, close: async () => undefined });
    await owner.apply(0o40700);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(chmod).not.toHaveBeenCalled();
    expect(prepareChmod).not.toHaveBeenCalled();
    await owner.verify();
    expect(inspect).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it.each(["beforeChmod", "check"] as const)("re-inspects after a %s callback changes the observed mode", async (hook) => {
    let mode = 0o700;
    const inspect = vi.fn(async () => mode);
    let checks = 0;
    const owner = ownDirectoryMode({ inspect, chmod: async () => undefined, close: async () => undefined });
    const callback = () => { mode = 0o755; };
    await expect(owner.apply(0o700, hook === "beforeChmod"
      ? { beforeChmod: async () => callback() }
      : { check: () => { if (++checks === 2) callback(); } },
    )).rejects.toMatchObject({ code: "path-mismatch" });
    expect(inspect.mock.calls.length).toBeGreaterThan(1);
    await owner.close();
  });

  it("retains the checks after preparation, user code, and chmod", async () => {
    let mode = 0o755;
    const events: string[] = [];
    const owner = ownDirectoryMode({
      inspect: async () => { events.push("inspect"); return mode; },
      prepareChmod: async () => { events.push("prepare"); },
      chmod: async (value) => { events.push("chmod"); mode = value; },
      verifyChmod: async () => { events.push("verify chmod"); },
      close: async () => undefined,
    });
    await owner.apply(0o700, { beforeChmod: async () => { events.push("hook"); } });
    expect(events).toEqual(["inspect", "prepare", "hook", "inspect", "chmod", "verify chmod", "inspect"]);
    await owner.close();
  });
});
