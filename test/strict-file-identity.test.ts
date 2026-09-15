import { describe, expect, it, vi } from "vitest";
import { inspectFileIdentity, inspectFileIdentitySync } from "../src/strict-file-identity.js";

type Identity = { dev: bigint; ino: bigint };
const known = { dev: 7n, ino: 9007199254740992n };

function observedIdentity(
  events: string[],
  label: string,
  values: { dev(): bigint; ino(): bigint },
): Identity {
  return {
    get dev() {
      events.push(`${label}.dev`);
      return values.dev();
    },
    get ino() {
      events.push(`${label}.ino`);
      return values.ino();
    },
  };
}

describe.each(["sync", "async"] as const)("strict %s identity inspection", (kind) => {
  async function inspect(
    read: () => Identity,
    expected?: Identity,
    platform: NodeJS.Platform = "win32",
  ) {
    return kind === "sync"
      ? inspectFileIdentitySync(read, expected, platform)
      : await inspectFileIdentity(async () => read(), expected, platform);
  }

  it("distinguishes exact identities with the same numeric representation", async () => {
    const different = { ...known, ino: known.ino + 1n };
    expect(Number(different.ino)).toBe(Number(known.ino));
    const read = vi.fn(() => different);
    await expect(inspect(read, known)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns the exact receipt without retrying a known match", async () => {
    const read = vi.fn(() => known);
    await expect(inspect(read, known)).resolves.toBe(known);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(["dev", "ino"] as const)(
    "reads expected fields once before ordered retry observations for unknown %s",
    async (field) => {
      const events: string[] = [];
      let expectedValues = known;
      const expected = observedIdentity(events, "expected", {
        dev: () => expectedValues.dev,
        ino: () => expectedValues.ino,
      });
      const first = observedIdentity(events, "first", {
        dev: () => field === "dev" ? 0n : known.dev,
        ino: () => field === "ino" ? 0n : known.ino,
      });
      const second = observedIdentity(events, "second", {
        dev: () => known.dev,
        ino: () => known.ino,
      });
      let calls = 0;
      const read = vi.fn(() => {
        events.push(`inspect.${++calls}`);
        expectedValues = { dev: known.dev + 1n, ino: known.ino + 1n };
        return calls === 1 ? first : second;
      });
      await expect(inspect(read, expected)).resolves.toBe(second);
      expect(read).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        "expected.dev", "expected.ino",
        "inspect.1", "first.dev", "first.ino",
        "inspect.2", "second.dev", "second.ino",
      ]);
    },
  );

  it("rejects a known device mismatch before reading a throwing inode getter", async () => {
    const events: string[] = [];
    const failure = new Error("inode must not be read");
    const observed = observedIdentity(events, "observed", {
      dev: () => known.dev + 1n,
      ino: () => { throw failure; },
    });
    const read = vi.fn(() => {
      events.push("inspect");
      return observed;
    });
    await expect(inspect(read, known)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["inspect", "observed.dev"]);
  });

  it.each([
    ["expected", "dev"], ["expected", "ino"],
    ["observed", "dev"], ["observed", "ino"],
  ] as const)("rejects a numeric %s %s before subsequent observations", async (phase, field) => {
    const events: string[] = [];
    const numeric = observedIdentity(events, phase, {
      dev: () => field === "dev" ? 7 as unknown as bigint : known.dev,
      ino: () => field === "ino" ? 9 as unknown as bigint : known.ino,
    });
    const read = vi.fn(() => {
      events.push("inspect");
      return phase === "observed" ? numeric : known;
    });
    await expect(inspect(read, phase === "expected" ? numeric : known))
      .rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(phase === "expected" ? 0 : 1);
    expect(events).toEqual([
      ...(phase === "observed" ? ["inspect"] : []),
      `${phase}.dev`,
      ...(field === "ino" ? [`${phase}.ino`] : []),
    ]);
  });

  it.each([
    ["expected", "dev"], ["expected", "ino"],
    ["first", "dev"], ["first", "ino"],
    ["second", "dev"], ["second", "ino"],
  ] as const)("preserves a throwing %s %s getter and stops observing", async (phase, field) => {
    const events: string[] = [];
    const failure = new Error(`${phase}.${field}`);
    const observation = (label: string) => observedIdentity(events, label, {
      dev: () => {
        if (label === phase && field === "dev") throw failure;
        return label === "first" && phase === "second" ? 0n : known.dev;
      },
      ino: () => {
        if (label === phase && field === "ino") throw failure;
        return known.ino;
      },
    });
    const expected = observation("expected");
    const first = observation("first");
    const second = observation("second");
    let calls = 0;
    const read = vi.fn(() => {
      events.push(`inspect.${++calls}`);
      return calls === 1 ? first : second;
    });
    await expect(inspect(read, expected)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(phase === "expected" ? 0 : phase === "first" ? 1 : 2);
    expect(events).toEqual([
      ...(phase !== "expected" ? ["expected.dev", "expected.ino"] : []),
      ...(phase === "second" ? ["inspect.1", "first.dev", "first.ino"] : []),
      ...(phase !== "expected" ? [`inspect.${phase === "first" ? 1 : 2}`] : []),
      `${phase}.dev`,
      ...(field === "ino" ? [`${phase}.ino`] : []),
    ]);
  });

  it("reads a throwing expected inode even when its device is unknown", async () => {
    const events: string[] = [];
    const failure = new Error("expected inode failed");
    const expected = observedIdentity(events, "expected", {
      dev: () => 0n,
      ino: () => { throw failure; },
    });
    const read = vi.fn(() => known);
    await expect(inspect(read, expected)).rejects.toBe(failure);
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual(["expected.dev", "expected.ino"]);
  });

  it.each(["dev", "ino"] as const)("retries a transient zero %s once", async (field) => {
    const read = vi.fn().mockReturnValueOnce({ ...known, [field]: 0n }).mockReturnValue(known);
    await expect(inspect(read, known)).resolves.toBe(known);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["dev", "ino"] as const)("refuses a persistent zero %s", async (field) => {
    const read = vi.fn(() => ({ ...known, [field]: 0n }));
    await expect(inspect(read, known)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not retry a known mismatch when the other component is unknown", async () => {
    const read = vi.fn().mockReturnValueOnce({ dev: 0n, ino: known.ino + 1n }).mockReturnValue(known);
    await expect(inspect(read, known)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retains a known component across an unknown first observation", async () => {
    const read = vi.fn().mockReturnValueOnce({ dev: 0n, ino: known.ino + 1n }).mockReturnValue(known);
    await expect(inspect(read)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not combine incomplete observations into a verified identity", async () => {
    const read = vi.fn().mockReturnValueOnce({ dev: 0n, ino: known.ino }).mockReturnValue({ dev: known.dev, ino: 0n });
    await expect(inspect(read)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refuses an unknown expected identity before inspecting", async () => {
    const read = vi.fn(() => known);
    await expect(inspect(read, { dev: 0n, ino: known.ino })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses numeric identities instead of converting rounded values", async () => {
    const read = vi.fn(() => ({ dev: 7, ino: Number(known.ino) }) as unknown as Identity);
    await expect(inspect(read)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not retry filesystem errors", async () => {
    const failure = Object.assign(new Error("stat denied"), { code: "EACCES" });
    const read = vi.fn(() => { throw failure; });
    await expect(inspect(read)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("preserves a symlink rejection during re-inspection", async () => {
    const failure = Object.assign(new Error("path became a symlink"), { code: "symlink" });
    const read = vi.fn().mockReturnValueOnce({ dev: known.dev, ino: 0n }).mockImplementation(() => { throw failure; });
    await expect(inspect(read, known)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("compares POSIX zero components exactly", async () => {
    const zero = { dev: 0n, ino: 0n };
    await expect(inspect(() => zero, zero, "linux")).resolves.toBe(zero);
    const read = vi.fn(() => zero);
    await expect(inspect(read, known, "linux")).rejects.toMatchObject({ code: "path-mismatch" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
