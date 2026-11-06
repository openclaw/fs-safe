import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, getFsSafeNativeConfig, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { inspectPathPermissions } from "../src/permissions.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { inspectWindowsDirectoryCommand } from "../src/windows-security-command.js";
import { readSecureFile } from "../src/secure-file.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useSuiteFixture } from "./helpers/suite-fixture.js";

const supported = ["read-true", "read-false", "read-inherited", "trusted-callback", "generic-read", "inherit-only"] as const;
const unsupported = ["write", "generic-write", "write-dac", "write-owner", "delete", "deny"] as const;
const names = [...supported, ...unsupported, "kernel-true", "kernel-false"];
const native = process.platform === "win32" ? (() => {
  try { return __loadBundledNativeForTest(); }
  catch (error) { if (getFsSafeNativeConfig().mode === "require") throw error; }
})() : undefined;

describe.runIf(!!native?.readOwnerAndDacl)("real Windows callback ACL inspection", () => {
  let directory: string;
  const withFixture = useSuiteFixture(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-callback-")));
    for (const name of names) await fs.writeFile(path.join(directory, name), "synthetic callback bytes");
    await fs.mkdir(path.join(directory, "private-parent"));
    const output = execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
      "-NoProfile", "-NonInteractive", "-File",
      fileURLToPath(new URL("./fixtures/windows-callback-acl.ps1", import.meta.url)), "-Root", directory,
    ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    return { directory, outcomes: JSON.parse(output.trim()) as Record<string, string> };
  }, async () => {
    vi.restoreAllMocks();
    __resetFsSafeNativeConfigForTest();
    __resetNativeLoaderForTest();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it("observes Windows applying true and false callback conditions differently", () => withFixture(async ({ outcomes }) => {
    expect(outcomes).toEqual({ "kernel-true": "read-allowed", "kernel-false": "read-denied" });
  }));

  it.each(supported)("reports %s as a possible read without evaluating its condition", name => withFixture(async () => {
    const target = path.join(directory, name);
    configureFsSafeNative({ mode: "require" });
    const raw = readOwnerAndDacl(target);
    expect(raw).toMatchObject({
      status: "supported", complete: true, unsupportedAceTypes: [],
      aces: expect.arrayContaining([expect.objectContaining({ aceType: "allow", isCallback: true })]),
    });
    if (name === "read-inherited") {
      expect(raw).toMatchObject({ aces: expect.arrayContaining([
        expect.objectContaining({ mask: 0x001200a9, isCallback: true,
          flags: expect.objectContaining({ raw: 19, inherited: true, inheritOnly: false }) }),
      ]) });
    }
    const exec = vi.fn(async () => { throw new Error("Unexpected native fallback"); });
    const direct = await inspectPathPermissions(target, { exec });
    expect(exec).not.toHaveBeenCalled();
    configureFsSafeNative({ mode: "off" });
    const fallback = await inspectPathPermissions(target);
    expect(direct).toMatchObject({
      source: "windows-acl", ownerTrusted: true, worldWritable: false, groupWritable: false,
      worldReadable: name !== "inherit-only" && name !== "trusted-callback",
    });
    for (const key of ["source", "worldReadable", "groupReadable", "worldWritable", "groupWritable", "ownerTrusted"] as const) {
      expect(fallback[key]).toEqual(direct[key]);
    }
    const fallbackRaw = readOwnerAndDacl(target);
    expect(fallbackRaw).toMatchObject({ status: "supported", complete: true,
      aces: expect.arrayContaining([expect.objectContaining({ isCallback: true })]) });
  }));

  it.each(unsupported)("keeps %s callbacks unverified in native and fallback paths", name => withFixture(async () => {
    const target = path.join(directory, name);
    for (const mode of ["require", "off"] as const) {
      configureFsSafeNative({ mode });
      expect(readOwnerAndDacl(target)).toMatchObject({
        status: "supported", complete: false, unsupportedAceTypes: [name === "deny" ? 10 : 9],
      });
      await expect(inspectPathPermissions(target)).resolves.toMatchObject({
        source: "unknown", error: "Windows ACL query returned incomplete descriptor data",
      });
    }
  }));

  it("retains callback observations through both shipped batch backends", () => withFixture(async () => {
    const { readOwnerAndDaclBatch } = await import("../dist/permissions-public.js");
    const config = await import("../dist/config.js");
    const previous = config.getFsSafeNativeConfig();
    try {
      for (const mode of ["require", "off"] as const) {
        config.configureFsSafeNative({ mode });
        const [result] = await readOwnerAndDaclBatch([path.join(directory, "read-true")]);
        expect(result).toMatchObject({ status: "supported", complete: true,
          aces: expect.arrayContaining([expect.objectContaining({ isCallback: true })]) });
      }
    } finally { config.configureFsSafeNative(previous); }
  }));

  it.each(supported)("does not admit a private file with a %s callback", name => withFixture(async () => {
    const target = path.join(directory, name);
    const open = fs.open.bind(fs);
    const reads: ReturnType<typeof vi.spyOn>[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      reads.push(vi.spyOn(handle, "read"));
      return handle;
    });
    try {
      for (const mode of ["require", "off"] as const) {
        configureFsSafeNative({ mode });
        await expect(readSecureFile({ filePath: target })).rejects.toMatchObject({ code: "permission-unverified" });
      }
      expect(reads).toHaveLength(2);
      for (const read of reads) expect(read).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  }));

  it("preserves native and helper private-directory rejection", () => withFixture(async () => {
    const target = path.join(directory, "private-parent");
    expect(() => native!.inspectWindowsDirectory!(target, true)).toThrow(expect.objectContaining({ code: "EACCES" }));
    await expect(inspectWindowsDirectoryCommand(target, true)).rejects.toMatchObject({ code: "EACCES" });
    expect(native!.inspectWindowsDirectory!(target, false).identity).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
  }));
});
