import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { paxNative as native } from "./helpers/archive-pax-native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const windowsSource = fs.readFileSync(
  new URL("../native/src/windows.rs", import.meta.url),
  "utf8",
);
const { tempRoot } = useRealTempDirs();

function fdMatchesIdentity(fd: number, expected: { dev: bigint; ino: bigint }): boolean {
  try {
    const actual = fs.fstatSync(fd, { bigint: true });
    return actual.dev === expected.dev && actual.ino === expected.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBADF") return false;
    throw error;
  }
}

it("keeps the Windows N-API descriptor boundary exclusively in one host libuv table", () => {
  expect(windowsSource).toContain("static BRIDGE: OnceLock<Option<UvBridge>>");
  expect(windowsSource).toContain('c"uv_get_osfhandle"');
  expect(windowsSource).toContain('c"uv_open_osfhandle"');
  expect(windowsSource.match(/GetModuleHandleW\(null\(\)\)/gu)).toHaveLength(1);
  expect(windowsSource).not.toMatch(/#\[link\(name = "(?:msvcrt|ucrt)"\)\]/u);
  expect(windowsSource).not.toMatch(/fn _(?:get|open)_osfhandle\b/u);
  expect(windowsSource).not.toMatch(/let direct = fd as (?:usize|isize) as HANDLE/u);
  expect(windowsSource).not.toContain("GetFileInformationByHandle(direct");
});

describe.runIf(process.platform === "win32" && native)("Windows host libuv descriptor bridge", () => {
  it("uses a Node directory descriptor without consuming or replacing it", async () => {
    const root = await tempRoot("fs-safe-win-fd-mkdir-");
    const rootFd = fs.openSync(root, fs.constants.O_RDONLY);
    try {
      const before = fs.fstatSync(rootFd, { bigint: true });
      native!.mkdirBeneath(rootFd, "created", 0o700);
      expect(fs.lstatSync(path.join(root, "created")).isDirectory()).toBe(true);
      const after = fs.fstatSync(rootFd, { bigint: true });
      expect(after.isDirectory()).toBe(true);
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    } finally {
      fs.closeSync(rootFd);
    }
  });

  it("reports direct-child creation, closes its transient handle, and rejects nested names", async () => {
    const root = await tempRoot("fs-safe-win-fd-mkdir-child-");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "file"), "preserve");
    const rootFd = fs.openSync(root, fs.constants.O_RDONLY);
    const mkdirChild = native!.mkdirChildBeneath;
    expect(mkdirChild).toBeTypeOf("function");
    if (!mkdirChild) throw new Error("native direct-child mkdir is unavailable");
    try {
      expect(mkdirChild.call(native, rootFd, "created", 0o700)).toBe(true);
      for (let index = 0; index < 128; index += 1) {
        expect(mkdirChild.call(native, rootFd, "created", 0o700)).toBe(false);
      }
      fs.rmdirSync(path.join(root, "created"));
      expect(fs.existsSync(path.join(root, "created"))).toBe(false);
      expect(mkdirChild.call(native, rootFd, "created", 0o700)).toBe(true);
      expect(mkdirChild.call(native, rootFd, "file", 0o700)).toBe(false);
      expect(fs.readFileSync(path.join(root, "file"), "utf8")).toBe("preserve");
      for (const invalid of ["", ".", "..", "nested/child", "nested\\child", "nul\0child"]) {
        expect(() => mkdirChild.call(native, rootFd, invalid, 0o700)).toThrowError(
          expect.objectContaining({ code: "EINVAL" }),
        );
      }
      expect(fs.readdirSync(path.join(root, "nested"))).toEqual([]);
      expect(fs.fstatSync(rootFd).isDirectory()).toBe(true);
    } finally {
      fs.closeSync(rootFd);
    }
  });

  it("returns a descriptor that Node reads and stats before its native owner closes it", async () => {
    const root = await tempRoot("fs-safe-win-fd-open-");
    const payload = Buffer.from("host libuv descriptor proof");
    const target = path.join(root, "payload");
    fs.writeFileSync(target, payload);
    const rootFd = fs.openSync(root, fs.constants.O_RDONLY);
    try {
      const rootBefore = fs.fstatSync(rootFd, { bigint: true });
      const fileBefore = fs.statSync(target, { bigint: true });
      const opened = native!.openBeneath(rootFd, "payload", fs.constants.O_RDONLY);
      try {
        const received = Buffer.alloc(payload.length);
        expect(fs.readSync(opened.fd, received, 0, received.length, 0)).toBe(payload.length);
        expect(received).toEqual(payload);
        const stat = fs.fstatSync(opened.fd, { bigint: true });
        expect(stat.isFile()).toBe(true);
        expect(stat.size).toBe(BigInt(payload.length));
        expect({ dev: stat.dev, ino: stat.ino }).toEqual({ dev: fileBefore.dev, ino: fileBefore.ino });
      } finally {
        native!.closeOwnedFd(opened.fd);
      }
      // A reused descriptor may identify another file; it must not retain ours.
      expect(fdMatchesIdentity(opened.fd, fileBefore)).toBe(false);

      const duplicated = native!.openBeneath(rootFd, ".", fs.constants.O_RDONLY);
      try {
        expect(fdMatchesIdentity(duplicated.fd, rootBefore)).toBe(true);
      } finally {
        native!.closeOwnedFd(duplicated.fd);
      }
      expect(fdMatchesIdentity(duplicated.fd, rootBefore)).toBe(false);
      const rootAfter = fs.fstatSync(rootFd, { bigint: true });
      expect({ dev: rootAfter.dev, ino: rootAfter.ino }).toEqual({
        dev: rootBefore.dev,
        ino: rootBefore.ino,
      });
      expect(fs.readFileSync(target)).toEqual(payload);
    } finally {
      fs.closeSync(rootFd);
    }
  });

  it("rejects invalid and closed Node descriptors without creating a child", async () => {
    const root = await tempRoot("fs-safe-win-fd-invalid-");
    const closedFd = fs.openSync(root, fs.constants.O_RDONLY);
    fs.closeSync(closedFd);
    for (const [fd, name] of [[-1, "negative"], [closedFd, "closed"]] as const) {
      expect(() => native!.mkdirBeneath(fd, name, 0o700)).toThrowError(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(fs.existsSync(path.join(root, name))).toBe(false);
    }
  });
});
