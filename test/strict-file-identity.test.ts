import { describe, expect, it, vi } from "vitest";
import { inspectFileIdentity, inspectFileIdentitySync } from "../src/strict-file-identity.js";

type Identity = { dev: bigint; ino: bigint };
const known = { dev: 7n, ino: 9007199254740992n };

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
