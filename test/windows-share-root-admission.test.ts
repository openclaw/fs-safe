import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveSecurityError } from "../src/archive-errors.js";
import { prepareArchiveOutputPath, preparePrivateArchiveOutputPath } from "../src/archive-staging.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { resolveRootPath } from "../src/root-path.js";
import { rawPathRelativeToCanonicalRoot } from "../src/root-path-existing.js";
import { pathScope } from "../src/root-paths.js";
import { isPathInside } from "../src/path.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret-file.js";
import { writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { movePathToTrash } from "../src/trash.js";
import { isForeignWindowsShareOrDevicePath } from "../src/windows-path-alias.js";
import { windowsShareOrDeviceRoot } from "../src/windows-path-syntax.js";
import { expectFsSafeCode } from "./helpers/security.js";
import { allowWindowsFilesystemStalls, itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

allowWindowsFilesystemStalls();
const { tempRoot } = useRealTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  __resetFsSafeNativeConfigForTest();
});

const share = "\\\\server\\share";
const foreignPaths: [string, string | null][] = [
  ["\\\\server\\share\\secret.txt", share],
  ["//server/share/secret.txt", share],
  ["\\\\?\\UNC\\server\\share\\secret.txt", share],
  ["//?/UNC/server/share/x", share],
  ["\\\\.\\UNC\\server\\share\\x", share],
  ["\\\\server\\\\share\\x", "\\\\server\\\\share"],
  ["\\/server/share/x", share],
  ["/\\server\\share", share],
  ["\\\\server\\share", share],
  ["\\\\server\\share\\", share],
  ["\\\\.\\pipe\\x", "\\\\.\\pipe"],
  ["\\\\?\\GLOBALROOT\\Device\\Mup\\server\\share\\x", null],
  ["\\\\.\\globalroot\\Device\\Mup\\server\\share\\x", null],
  ["\\\\?\\Global\\UNC\\server\\share\\x", null],
  ["\\\\.\\C:\\..\\UNC\\server\\share\\x", null],
  ["//./C:/../UNC/server/share/x", null],
  ["\\\\?\\UNC\\server\\share\\..\\..\\other\\share\\x", null],
  ["\\\\.\\UNC\\server\\share\\.. \\..\\other\\share\\x", null],
  ["\\\\.\\GLOBALROOT.\\Device\\Mup\\server\\share\\x", null],
  ["\\\\.\\Global \\UNC\\server\\share\\x", null],
  ["\\\\.\\\\GLOBALROOT\\Device\\Mup\\server\\share\\x", null],
  ["\\\\.\\UNC.\\server\\share\\x", null],
  ["\\\\.\\UNC\\server.\\share\\x", null],
  ["\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x", "\\\\?\\volume{00000000-0000-0000-0000-000000000000}"],
  ["\\\\.\\PhysicalDrive0", "\\\\.\\physicaldrive0"],
  ["\\\\server\\", ""],
  ["\\\\\\x", ""],
  ["\\\\?\\UNC\\", null],
  ["\\\\?\\UNC\\server", null],
  ["\\\\.\\", null],
];
const localPaths = [
  "C:\\Windows\\win.ini", "D:\\x", "\\\\?\\C:\\x", "\\\\.\\C:\\x",
  "//?/C:/x", "relative\\x", "\\rooted\\x",
  "\\\\?\\C:\\.\\x", "\\\\?\\C:\\x.", "\\\\?\\C:\\root\\a\\..\\b",
];
const sharePaths: [string, string, boolean][] = [
  ["\\\\SERVER\\Share\\other\\x", share, false],
  ["\\\\?\\UNC\\server\\share\\x", share, false],
  ["//server/share/x", share, false],
  ["\\\\.\\uNc\\SERVER\\SHARE\\x", share, false],
  ["\\\\server\\other\\x", "\\\\server\\other", true],
  ["\\\\other\\share\\x", "\\\\other\\share", true],
];

describe("Windows share and device root syntax", () => {
  it.each(foreignPaths)("rejects %s against a drive root", (value, key) => {
    expect(windowsShareOrDeviceRoot(value)).toBe(key);
    expect(isForeignWindowsShareOrDevicePath(value, ["C:\\work\\root"], "win32")).toBe(true);
  });

  it.each(localPaths)("keeps local spelling %s", value => {
    expect(windowsShareOrDeviceRoot(value)).toBeUndefined();
    expect(isForeignWindowsShareOrDevicePath(value, ["C:\\work\\root"], "win32")).toBe(false);
  });

  it.each(sharePaths)("compares the trusted share for %s", (value, key, foreign) => {
    expect(windowsShareOrDeviceRoot(value)).toBe(key);
    expect(isForeignWindowsShareOrDevicePath(value, [`${share}\\root`], "win32")).toBe(foreign);
  });

  it("does not fold a Kelvin-sign host into an ASCII trusted host", () => {
    const value = "\\\\\u212Aost\\share\\x";
    expect(windowsShareOrDeviceRoot(value)).toBe("\\\\\u212Aost\\share");
    expect(isForeignWindowsShareOrDevicePath(value, ["\\\\kost\\share\\root"], "win32")).toBe(true);
  });

  it("never trusts a namespace spelling whose share or device is not syntactic", () => {
    // Node resolves this through the drive root to \\.\UNC\other\share\x.
    expect(path.win32.resolve("\\\\.\\C:\\..\\UNC\\other\\share\\x")).toBe("\\\\.\\UNC\\other\\share\\x");
    const trusted = [
      "C:\\root", `${share}\\root`, "\\\\?\\UNC\\server\\share\\root",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\root", "\\\\?\\Global\\UNC\\server\\share\\root",
      "\\\\.\\GLOBALROOT.\\Device\\HarddiskVolume1\\root",
    ];
    for (const value of [
      "\\\\.\\GLOBALROOT.\\Device\\Mup\\other\\share\\x",
      "\\\\?\\GLOBALROOT\\Device\\Mup\\other\\share\\x",
      "\\\\?\\GLOBALROOT\\device\\HarddiskVolumeShadowCopy1\\root\\x",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\root\\..\\..\\Mup\\other\\share\\x",
      "\\\\?\\Global\\UNC\\server\\share\\x",
      "\\\\.\\C:\\..\\UNC\\server\\share\\x",
      "\\\\?\\UNC\\server\\share\\..\\..\\other\\share\\x",
      "\\\\?\\UNC\\server\\share\\root\\..\\..\\..\\server\\share\\x",
    ]) {
      expect(isForeignWindowsShareOrDevicePath(value, trusted, "win32"), value).toBe(true);
    }
    // A spelling exactly under a trusted boundary reaches only what it reaches.
    expect(isForeignWindowsShareOrDevicePath(
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\root\\a\\..\\x", trusted, "win32",
    )).toBe(false);
    // Ordinary UNC dot segments stay under the share root in Node's resolver.
    expect(path.win32.resolve(`${share}\\..\\..\\other\\x`)).toBe(`${share}\\other\\x`);
    expect(isForeignWindowsShareOrDevicePath(`${share}\\..\\..\\other\\x`, trusted, "win32")).toBe(false);
  });

  it("accepts any matching defined trusted boundary, including a namespaced share", () => {
    expect(isForeignWindowsShareOrDevicePath(`${share}\\x`, [undefined, "C:\\root", "\\\\?\\UNC\\SERVER\\share\\root"], "win32")).toBe(false);
    expect(isForeignWindowsShareOrDevicePath(`${share}\\x`, [undefined], "win32")).toBe(true);
    expect(isForeignWindowsShareOrDevicePath(`${share}\\x`, [], "win32")).toBe(true);
  });

  it.each(["linux", "darwin"])("does not change admission on %s", platform => {
    const values = [...foreignPaths.map(([value]) => value), ...localPaths,
      ...sharePaths.map(([value]) => value), "\\\\\u212Aost\\share\\x"];
    for (const value of values) {
      expect(isForeignWindowsShareOrDevicePath(value, ["C:\\work\\root"], platform), value).toBe(false);
    }
  });
});

const canary = "fs-safe-unc-canary";
const canaryPayloads = [
  `\\\\${canary}\\share\\secret.txt`,
  `//${canary}/share/secret.txt`,
  `\\\\?\\UNC\\${canary}\\share\\secret.txt`,
  `\\\\.\\UNC\\${canary}\\share\\secret.txt`,
  `\\\\${canary}\\share`,
  `\\\\?\\GLOBALROOT\\Device\\Mup\\${canary}\\share\\x`,
  `\\\\.\\C:\\..\\UNC\\${canary}\\share\\secret.txt`,
];

function spyOnSyncFilesystem() {
  return [
    ...(["lstatSync", "statSync", "existsSync", "openSync", "accessSync", "readdirSync", "readlinkSync"] as const)
      .map(method => vi.spyOn(fs, method)),
    vi.spyOn(fs.realpathSync, "native"),
  ];
}

function spyOnFilesystem() {
  return [
    ...spyOnSyncFilesystem(),
    ...(["lstat", "stat", "realpath", "open", "access", "readdir", "mkdir", "readlink", "rm"] as const)
      .map(method => vi.spyOn(fsp, method)),
  ];
}

function expectNoCanaryCalls(spies: { mock: { calls: unknown[][] } }[]) {
  for (const spy of spies) {
    expect(spy.mock.calls.filter(args => String(args[0]).includes(canary))).toEqual([]);
  }
}

itPosix("rejects a foreign share before a canonical alias walk under Windows admission", async () => {
  const directory = await tempRoot("fs-safe-share-admission-");
  const spies = spyOnSyncFilesystem();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  await expect(resolveRootPath({
    rootPath: directory,
    absolutePath: `//${canary}/share/secret.txt`,
    boundaryLabel: "workspace",
  })).rejects.toThrow("Path escapes workspace");
  expectNoCanaryCalls(spies);
});

itPosix("defends a direct canonical alias-walk caller before any foreign share lookup", async () => {
  const directory = await tempRoot("fs-safe-share-walk-");
  const spies = spyOnSyncFilesystem();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  expect(rawPathRelativeToCanonicalRoot(`//${canary}/share/secret.txt`, directory)).toBeUndefined();
  expectNoCanaryCalls(spies);
});

itWin32.each(["default", "off"] as const)("rejects foreign Root and pathScope inputs without filesystem dispatch (%s native)", async mode => {
  if (mode === "off") configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-share-public-");
  const scopedRoot = await root(directory);
  const scope = pathScope(directory, { label: "workspace" });
  const spies = spyOnFilesystem();
  for (const value of canaryPayloads) {
    const operations = [
      () => scopedRoot.read(value),
      () => scopedRoot.open(value),
      () => scopedRoot.stat(value),
      () => scopedRoot.list(value),
      () => scopedRoot.write(value, "blocked"),
      () => scopedRoot.mkdir(value),
      () => scopedRoot.remove(value),
      () => scopedRoot.exists(value),
    ];
    for (const operation of operations) {
      const error = await operation().then(() => undefined, (reason: unknown) => reason);
      // Reads reject `\\.\` and GLOBALROOT device spellings lexically as device-path first.
      expectFsSafeCode(error, ["outside-workspace", "invalid-path", "path-alias", "device-path"]);
    }
    for (const operation of [
      () => scope.existing([value]), () => scope.files([value]),
      () => scope.writable(value), () => scope.ensureDir(value),
    ]) {
      await expect(operation()).resolves.toMatchObject({ ok: false });
    }
  }
  expectNoCanaryCalls(spies);
});

const auditSites = ["secret-write", "secret-create", "sibling-temp", "trash", "archive-public", "archive-private"] as const;
type AuditSite = typeof auditSites[number];

async function expectAuditSiteRejection(
  site: AuditSite, directory: string, value: string,
  spies: ReturnType<typeof spyOnFilesystem>,
) {
  const writeTemp = vi.fn(async () => {});
  let operation: Promise<unknown>;
  let message: string;
  if (site === "secret-write" || site === "secret-create") {
    const write = site === "secret-write" ? writeSecretFileAtomic : createSecretFileAtomic;
    operation = write({ rootDir: directory, filePath: value, content: "blocked" });
    message = `Private secret path must stay under ${path.resolve(directory)}.`;
  } else if (site === "sibling-temp") {
    operation = writeViaSiblingTempPath({ rootDir: directory, targetPath: value, writeTemp });
    message = "Target path is outside the allowed root";
  } else if (site === "trash") {
    operation = movePathToTrash(value, { allowedRoots: [directory] });
    const resolved = path.resolve(value);
    message = resolved === path.parse(resolved).root
      ? `Refusing to trash root path: ${value}`
      : `Refusing to trash path outside allowed roots: ${value}`;
  } else {
    const prepare = site === "archive-public" ? prepareArchiveOutputPath : preparePrivateArchiveOutputPath;
    operation = prepare({
      destinationDir: directory, destinationRealDir: directory,
      relPath: "leaf", outPath: `${value}${path.sep}leaf`, originalPath: "leaf", isDirectory: false,
    });
    message = "archive entry traverses symlink in destination: leaf";
  }
  const error = await operation.then(() => undefined, (reason: unknown) => reason);
  expectNoCanaryCalls(spies);
  expect(error).toMatchObject({ message });
  if (site.startsWith("archive-")) {
    expect(error).toBeInstanceOf(ArchiveSecurityError);
    expect(error).toMatchObject({ code: "destination-symlink-traversal" });
  } else {
    expect(error?.constructor).toBe(Error);
  }
  expect(writeTemp).not.toHaveBeenCalled();
}

itPosix.each(auditSites)("rejects foreign %s inputs before filesystem dispatch under Windows admission", async site => {
  const directory = await tempRoot("fs-safe-share-audit-");
  const spies = spyOnFilesystem();
  const resolve = path.resolve;
  // POSIX resolve would erase the UNC prefix before the Windows gate sees it.
  vi.spyOn(path, "resolve").mockImplementation((...parts) => parts.some(part => part.includes(canary))
    ? path.win32.resolve(...parts).replaceAll("\\", "/") : resolve(...parts));
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  for (const value of canaryPayloads) await expectAuditSiteRejection(site, directory, value, spies);
});

itWin32.each(["default", "off"] as const)("rejects foreign audit-site inputs without filesystem dispatch (%s native)", async mode => {
  if (mode === "off") configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-share-audit-public-");
  const spies = spyOnFilesystem();
  for (const site of auditSites) {
    for (const value of canaryPayloads) await expectAuditSiteRejection(site, directory, value, spies);
  }
});

// U+212A KELVIN SIGN lowercases to ASCII "k", so Unicode-folding comparisons
// treat this host as the trusted one while Windows may resolve another name.
const kelvin = "K";
const kelvinHostShare = `fs-safe-${kelvin}ost-canary\\share\\root`;
const trustedHostShare = "fs-safe-kost-canary\\share\\root";

function expectNoKelvinCalls(spies: { mock: { calls: unknown[][] } }[]) {
  for (const spy of spies) {
    expect(spy.mock.calls.filter(args => String(args[0]).includes(kelvin))).toEqual([]);
  }
}

it("does not let Unicode case folding admit another share in Windows containment", () => {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  const trusted = `\\\\${trustedHostShare}`;
  expect(isPathInside(trusted, `\\\\${kelvinHostShare}\\leaf`)).toBe(false);
  expect(isPathInside(trusted, `\\\\FS-SAFE-KOST-CANARY\\share\\root\\leaf`)).toBe(true);
  const shadow = "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\root";
  expect(isPathInside(shadow, `${shadow}\\leaf`)).toBe(true);
});

itPosix("rejects a Unicode case-folded share before Root identity admission under Windows admission", async () => {
  const spies = spyOnFilesystem();
  const resolve = path.resolve;
  // POSIX resolve would erase the UNC prefix before the Windows gate sees it.
  vi.spyOn(path, "resolve").mockImplementation((...parts) => parts.some(part => part.includes("ost-canary"))
    ? path.win32.resolve(...parts).replaceAll("\\", "/") : resolve(...parts));
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  const rootPath = `//${trustedHostShare.replaceAll("\\", "/")}`;
  await expect(resolveRootPath({
    rootPath,
    rootCanonicalPath: rootPath,
    rootIdentity: { dev: 1n, ino: 1n },
    absolutePath: `//${kelvinHostShare.replaceAll("\\", "/")}/leaf`,
    boundaryLabel: "workspace",
  })).rejects.toThrow("Path escapes workspace");
  expectNoKelvinCalls(spies);
});

itWin32("rejects a Unicode case-folded share in pathScope and secret writers without filesystem dispatch", async () => {
  const rootDir = `\\\\${trustedHostShare}`;
  const value = `\\\\${kelvinHostShare}\\leaf`;
  // Windows path.relative folds the Kelvin sign, so containment alone would pass.
  expect(path.relative(rootDir, value)).toBe("leaf");
  const spies = spyOnFilesystem();
  const scope = pathScope(rootDir, { label: "workspace" });
  expect(scope.resolve(value)).toMatchObject({ ok: false });
  expect(scope.resolveAll([value])).toMatchObject({ ok: false });
  await expect(scope.writable(value)).resolves.toMatchObject({ ok: false });
  await expect(scope.ensureDir(value)).resolves.toMatchObject({ ok: false });
  for (const write of [writeSecretFileAtomic, createSecretFileAtomic]) {
    await expect(write({ rootDir, filePath: value, content: "blocked" }))
      .rejects.toThrow(`Private secret path must stay under ${rootDir}.`);
  }
  expectNoKelvinCalls(spies);
});

itWin32("keeps an allowed network Root working and rejects another share key before filesystem dispatch", async context => {
  const local = await tempRoot("fs-safe-share-network-");
  const drive = path.parse(local).root;
  const unc = /^[A-Za-z]:\\$/.test(drive) ? `\\\\localhost\\${drive[0]}$\\${local.slice(3)}` : undefined;
  // The loopback administrative share is optional outside hosted runners.
  if (unc === undefined || !fs.existsSync(unc)) return context.skip();
  await fsp.writeFile(path.join(local, "inside.txt"), "inside");
  const sameShare = `\\\\LOCALHOST\\${drive[0].toLowerCase()}$\\${local.slice(3)}\\inside.txt`;
  const resolved = await resolveRootPath({ rootPath: unc, absolutePath: sameShare, boundaryLabel: "workspace" });
  expect(resolved.relativePath).toBe("inside.txt");
  expect(resolved.kind).toBe("file");
  const spies = spyOnFilesystem();
  const otherShare = `\\\\127.0.0.1\\${drive[0]}$\\${local.slice(3)}\\inside.txt`;
  await expect(resolveRootPath({ rootPath: unc, absolutePath: otherShare, boundaryLabel: "workspace" }))
    .rejects.toThrow("Path escapes workspace");
  expect(pathScope(unc, { label: "workspace" }).resolve(otherShare)).toMatchObject({ ok: false });
  for (const spy of spies) {
    expect(spy.mock.calls.filter(args => String(args[0]).includes("127.0.0.1"))).toEqual([]);
  }
});
