import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

const appUid = 10176;
function androidIdentity(): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("android");
  vi.spyOn(process, "geteuid").mockReturnValue(appUid);
  vi.spyOn(process, "getegid").mockReturnValue(appUid);
  vi.spyOn(process, "getgroups").mockReturnValue([appUid, 3003]);
}

describe.runIf(process.platform !== "win32")("Android temp ancestry policy", () => {
  it.each([false, true])("accepts AID_SYSTEM ancestors (bigint=%s)", async (bigint) => {
    androidIdentity();
    const { assertTrustedTempWorkspaceDirectory: admit } = await import("../src/temp-workspace-child-admission.js");
    const stat = { uid: bigint ? 1000n : 1000, gid: bigint ? 1000n : 1000, mode: bigint ? 0o40771n : 0o40771 };
    expect(() => admit(stat, appUid, false, "/data")).not.toThrow();
    expect(() => admit(stat, appUid, true, "/data")).toThrowError(expect.objectContaining({ code: "not-owned" }));
  });

  it.each([
    { name: "foreign owner", uid: 1001, gid: 1001, mode: 0o755, code: "not-owned" },
    { name: "untrusted system group", uid: 1000, gid: 3003, mode: 0o771, code: "insecure-permissions" },
    { name: "world-writable system ancestor", uid: 1000, gid: 1000, mode: 0o777, code: "insecure-permissions" },
    { name: "untrusted app group", uid: appUid, gid: 3003, mode: 0o771, code: "insecure-permissions" },
    { name: "world-writable app ancestor", uid: appUid, gid: appUid, mode: 0o777, code: "insecure-permissions" },
    { name: "private app root", uid: appUid, gid: appUid, mode: 0o771, privateDirectory: true, code: "insecure-permissions" },
    { name: "non-app shared identity", uid: 2000, gid: 2000, mode: 0o771, euid: 2000, code: "insecure-permissions" },
  ])("rejects $name", async ({ uid, gid, mode, privateDirectory, euid, code }) => {
    androidIdentity();
    const { assertTrustedTempWorkspaceDirectory: admit } = await import("../src/temp-workspace-child-admission.js");
    expect(() => admit({ uid, gid, mode }, euid ?? appUid, privateDirectory ?? false, "/data/test"))
      .toThrowError(expect.objectContaining({ code }));
  });

  it.each(["effective", "supplementary", "unavailable", "invalid"])("rejects system group writable by caller: %s", async (kind) => {
    androidIdentity();
    if (kind === "invalid") vi.mocked(process.getegid).mockReturnValue(-1);
    if (kind === "effective") vi.mocked(process.getegid).mockReturnValue(1000);
    if (kind === "supplementary") vi.mocked(process.getgroups).mockReturnValue([appUid, 1000]);
    if (kind === "unavailable") vi.mocked(process.getgroups).mockImplementation(() => { throw new Error("unavailable"); });
    const { assertTrustedTempWorkspaceDirectory: admit } = await import("../src/temp-workspace-child-admission.js");
    expect(() => admit({ uid: 1000, gid: 1000, mode: 0o771 }, appUid, false, "/data"))
      .toThrowError(expect.objectContaining({ code: "insecure-permissions" }));
  });

  it.each([10176, 110176])("accepts only the calling app group, including multi-user UID %s", async (uid) => {
    androidIdentity();
    const { assertTrustedTempWorkspaceDirectory: admit } = await import("../src/temp-workspace-child-admission.js");
    expect(() => admit({ uid, gid: uid, mode: 0o771 }, uid, false, "/app/files")).not.toThrow();
    expect(() => admit({ uid, gid: uid + 1, mode: 0o771 }, uid, false, "/app/files"))
      .toThrowError(expect.objectContaining({ code: "insecure-permissions" }));
  });

  it.each(["linux", "darwin", "win32"] as const)("keeps %s ownership policy", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const { classifyTempWorkspaceOwner } = await import("../src/temp-workspace-ownership.js");
    expect(classifyTempWorkspaceOwner({ uid: 1000, gid: 1000 }, appUid)).toBe("foreign");
    const { assertTrustedTempWorkspaceDirectory: admit } = await import("../src/temp-workspace-child-admission.js");
    expect(() => admit({ uid: appUid, gid: appUid, mode: 0o771 }, appUid, false, "/app/files"))
      .toThrowError(expect.objectContaining({ code: "insecure-permissions" }));
  });
});

describe.runIf(process.platform !== "win32")("Termux workspace flow", () => {
  it.each(["async", "sync"] as const)("%s: validates the full /data ancestry and creates, writes, reads and cleans", async (variant) => {
    const base = await tempRoot("fs-safe-android-");
    const data = path.join(base, "data");
    const dataData = path.join(data, "data");
    const app = path.join(dataData, "com.termux");
    const files = path.join(app, "files");
    const prefix = path.join(files, "usr");
    const rootDir = path.join(prefix, "tmp");
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const nativeUid = process.geteuid();
    const lstat = fsSync.lstatSync.bind(fsSync);
    const fstat = fsSync.fstatSync.bind(fsSync);
    const map = (stat: fsSync.Stats | fsSync.BigIntStats, name?: unknown) => {
      const exact = typeof stat.uid === "bigint";
      const system = name === data || name === dataData;
      const own = stat.uid === nativeUid || stat.uid === BigInt(nativeUid);
      if (system || own) {
        stat.uid = exact ? BigInt(system ? 1000 : appUid) : system ? 1000 : appUid;
        stat.gid = stat.uid;
      }
      if (system || name === files) stat.mode = exact ? 0o40771n : 0o40771;
      return stat;
    };
    androidIdentity();
    vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => map(lstat(name, options), name) as never);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => map(fstat(fd, options)) as never);
    const { configureFsSafeNative } = await import("../src/native-config.js");
    configureFsSafeNative({ mode: "off" });
    const { resolveSecureTempRoot } = await import("../src/secure-temp-dir.js");
    expect(resolveSecureTempRoot({ preferredDir: rootDir, fallbackPrefix: "openclaw", getuid: () => appUid })).toBe(rootDir);
    const { withTempWorkspace, withTempWorkspaceSync } = await import("../src/temp.js");
    const run = () => variant === "async"
      ? withTempWorkspace({ rootDir, prefix: "plugin-" }, async (workspace) => {
        await workspace.writeText("proof", "private");
        return (await workspace.read("proof")).toString();
      })
      : withTempWorkspaceSync({ rootDir, prefix: "plugin-" }, (workspace) => {
        workspace.writeText("proof", "private");
        return workspace.read("proof").toString();
      });
    expect(await run()).toBe("private");
    expect(await fs.readdir(rootDir)).toEqual([]);
    // A later untrusted owner above HOME/PREFIX must still be noticed.
    vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
      const stat = map(lstat(name, options), name);
      if (name === data) stat.uid = typeof stat.uid === "bigint" ? 1001n : 1001;
      return stat as never;
    });
    await expect(Promise.resolve().then(run)).rejects.toMatchObject({ code: "not-owned" });
    expect(await fs.readdir(rootDir)).toEqual([]);
  }, 30_000);
});
