import { expect, it, vi } from "vitest";
import { inspectWindowsOwner, resolveWindowsPrincipalSids } from "../src/windows-owner.js";

const env = { SystemRoot: String.raw`C:\Windows` };
const sid = "S-1-5-21-1-2-3-1000";

it("resolves principals named like inherited object properties", async () => {
  const exec = vi.fn(async () => ({ stdout: JSON.stringify([
    { name: "constructor", sid }, { name: "__proto__", sid },
  ]), stderr: "" }));
  const resolved = await resolveWindowsPrincipalSids({ principals: ["constructor", "__proto__"], env, exec });
  expect(exec).toHaveBeenCalledTimes(1);
  for (const name of ["constructor", "__proto__"]) {
    expect(Object.hasOwn(resolved, name)).toBe(true);
    expect(resolved[name]).toBe(sid.toLowerCase());
  }
});

it("accepts explicit known SID entries for prototype-shaped names", async () => {
  const known = Object.fromEntries(["constructor", "__proto__"].map(name => [name, sid]));
  const exec = vi.fn(async () => { throw new Error("unexpected lookup"); });
  const resolved = await resolveWindowsPrincipalSids({ principals: Object.keys(known), known, env, exec });
  expect(exec).not.toHaveBeenCalled();
  expect(resolved.__proto__).toBe(sid.toLowerCase());
  expect(resolved.constructor).toBe(sid.toLowerCase());
});

it("rejects missing translated entries even when their name is inherited", async () => {
  const exec = vi.fn(async () => ({ stdout: JSON.stringify([{ name: "constructor", sid }]), stderr: "" }));
  await expect(resolveWindowsPrincipalSids({ principals: ["constructor", "__proto__"], env, exec }))
    .rejects.toThrow("incomplete SID data");
});

it("preserves prototype-shaped names in owner-query SID rows", async () => {
  const result = await inspectWindowsOwner({ targetPath: String.raw`C:\fixture`, env,
    exec: async () => ({ stdout: JSON.stringify({ ownerSid: sid, currentUserSid: sid,
      principalSids: [{ name: "__proto__", sid }] }), stderr: "" }),
  });
  expect(result.trusted).toBe(true);
  expect(Object.hasOwn(result.principalSids!, "__proto__")).toBe(true);
  expect(result.principalSids!.__proto__).toBe(sid.toLowerCase());
});
