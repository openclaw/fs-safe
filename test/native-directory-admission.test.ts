import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostNativeTarget } from "../scripts/native-targets.mjs";
import { paxNative as native } from "./helpers/archive-pax-native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;

describe.skipIf(process.platform !== "linux" || !native)("native directory admission", () => {
  it("opens directories and creates regular files with the correct mode argument", async () => {
    const dir = await tempRoot("fs-safe-native-directory-");
    fs.mkdirSync(path.join(dir, "nested"));
    const root = fs.openSync(dir, directoryFlags);
    try {
      const opened = native!.openBeneath(root, "nested", directoryFlags);
      try { expect(fs.fstatSync(opened.fd).isDirectory()).toBe(true); }
      finally { native!.closeOwnedFd(opened.fd); }
      const file = native!.openBeneath(root, "created", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      try { expect(fs.fstatSync(file.fd).isFile()).toBe(true); }
      finally { native!.closeOwnedFd(file.fd); }
    } finally { fs.closeSync(root); }
  });

  it("reports direct-child creation without collision or descriptor ownership ambiguity", async () => {
    const dir = await tempRoot("fs-safe-native-mkdir-child-");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "file"), "preserve");
    const root = fs.openSync(dir, directoryFlags);
    const mkdirChild = native!.mkdirChildBeneath;
    expect(mkdirChild).toBeTypeOf("function");
    if (!mkdirChild) throw new Error("native direct-child mkdir is unavailable");
    try {
      const descriptorCount = () => fs.readdirSync("/proc/self/fd").length;
      const before = descriptorCount();
      expect(mkdirChild.call(native, root, "created", 0o700)).toBe(true);
      for (let index = 0; index < 128; index += 1) {
        expect(mkdirChild.call(native, root, "created", 0o700)).toBe(false);
      }
      expect(descriptorCount()).toBe(before);
      expect(mkdirChild.call(native, root, "file", 0o700)).toBe(false);
      expect(fs.readFileSync(path.join(dir, "file"), "utf8")).toBe("preserve");
      expect(mkdirChild.call(native, root, "literal\\child", 0o700)).toBe(true);
      for (const invalid of ["", ".", "..", "nested/child", "/absolute", "nul\0child"]) {
        expect(() => mkdirChild.call(native, root, invalid, 0o700)).toThrowError(
          expect.objectContaining({ code: "EINVAL" }),
        );
      }
      expect(fs.readdirSync(path.join(dir, "nested"))).toEqual([]);
    } finally { fs.closeSync(root); }
  });

  it("rejects regular files before applying a directory open's truncate flag", async () => {
    const dir = await tempRoot("fs-safe-native-directory-type-");
    const target = path.join(dir, "file");
    fs.writeFileSync(target, "preserve these bytes");
    const root = fs.openSync(dir, directoryFlags);
    try {
      for (const flags of [directoryFlags, fs.constants.O_WRONLY | fs.constants.O_DIRECTORY | fs.constants.O_TRUNC]) {
        expect(() => native!.openBeneath(root, "file", flags)).toThrowError(expect.objectContaining({ code: "ENOTDIR" }));
        expect(fs.readFileSync(target, "utf8")).toBe("preserve these bytes");
      }
    } finally { fs.closeSync(root); }
  });

  it.each(["open", "mkdir"])("rejects a writerless FIFO during %s without blocking", async (operation) => {
    const dir = await tempRoot("fs-safe-native-directory-fifo-");
    const fifo = path.join(dir, "fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const artifact = fileURLToPath(new URL(`../native/${hostNativeTarget()!.artifact}`, import.meta.url));
    // Only the potentially blocking operation is under the child deadline.
    const child = spawnSync(process.execPath, ["-e", `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const native = require(process.argv[1]);
      const fd = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        assert.throws(() => process.argv[3] === "open"
          ? native.openBeneath(fd, "fifo", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
          : native.mkdirBeneath(fd, "fifo/child", 0o700), { code: "ENOTDIR" });
      } finally { fs.closeSync(fd); }
    `, artifact, dir, operation], { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["fifo"]);
  }, 10_000);
});
