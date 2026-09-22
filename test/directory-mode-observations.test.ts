import { describe, expect, it, vi } from "vitest";
import { ownDirectoryMode } from "../src/directory-mode-node.js";

const falsyThrownValues: { name: string; value: unknown }[] = [
  { name: "undefined", value: undefined },
  { name: "null", value: null },
  { name: "false", value: false },
  { name: "positive zero", value: 0 },
  { name: "negative zero", value: -0 },
  { name: "zero bigint", value: 0n },
  { name: "empty string", value: "" },
  { name: "NaN", value: Number.NaN },
];

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

  it.each(falsyThrownValues)(
    "preserves a deferred $name check failure after chmod verification",
    async ({ value }) => {
      let mode = 0o700;
      let checks = 0;
      const events: string[] = [];
      const owner = ownDirectoryMode({
        inspect: async () => { events.push("inspect"); return mode; },
        chmod: async (nextMode) => { events.push("chmod"); mode = nextMode; },
        verifyChmod: async () => { events.push("verify chmod"); },
        close: async () => undefined,
      });
      try {
        let rejected = false;
        let observed: unknown = Symbol("not rejected");
        await owner.apply(0o755, {
          check: () => {
            checks += 1;
            events.push(`check ${checks}`);
            if (checks === 7) throw value;
          },
        }).then(
          () => undefined,
          (error: unknown) => { rejected = true; observed = error; },
        );

        expect(rejected).toBe(true);
        expect(Object.is(observed, value)).toBe(true);
        expect(mode).toBe(0o755);
        expect(events).toEqual([
          "check 1", "inspect", "check 2", "check 3", "check 4", "inspect",
          "check 5", "check 6", "chmod", "check 7", "verify chmod", "inspect",
        ]);
      } finally {
        await owner.close();
      }
    },
  );
});
