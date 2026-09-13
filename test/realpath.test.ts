import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe.skipIf(process.platform === "win32")("POSIX canonical paths", () => {
  it("keeps literal backslashes distinct from a colliding directory path", async () => {
    const directory = await tempRoot("fs-safe-realpath-literal-");
    fs.mkdirSync(path.join(directory, "a"));
    fs.writeFileSync(path.join(directory, "a", "file"), "slash");
    const literal = path.join(directory, "a\\file");
    fs.writeFileSync(literal, "backslash");
    for (const resolve of [realpathSync, realpathSync.native]) {
      expect(resolve(literal)).toBe(literal);
      expect(fs.readFileSync(resolve(literal), "utf8")).toBe("backslash");
    }
  });

  it("preserves the native and ordinary symlink-before-parent contracts", async () => {
    const directory = await tempRoot("fs-safe-realpath-parent-");
    fs.mkdirSync(path.join(directory, "target", "child"), { recursive: true });
    fs.symlinkSync("target/child", path.join(directory, "link"));
    expect(realpathSync(path.join(directory, "link"))).toBe(path.join(directory, "target", "child"));
    // path.join would erase the component whose ordering is being tested.
    const input = `${directory}/link/..`;
    expect(realpathSync.native(input)).toBe(path.join(directory, "target"));
    expect(realpathSync(input)).toBe(directory);
    fs.symlinkSync("link/..", path.join(directory, "indirect"));
    expect(realpathSync.native(path.join(directory, "indirect"))).toBe(path.join(directory, "target"));
    expect(realpathSync(path.join(directory, "indirect"))).toBe(directory);
  });

  it.skipIf(process.getuid?.() === 0)("resolves restrictive leaves without granting read permission", async () => {
    const directory = await tempRoot("fs-safe-realpath-mode-");
    const searchOnly = path.join(directory, "search");
    fs.mkdirSync(searchOnly);
    const file = path.join(searchOnly, "MixedCase");
    fs.writeFileSync(file, "private", { mode: 0o000 });
    const caseAlias = path.join(searchOnly, "mixedcase");
    const caseInsensitive = fs.existsSync(caseAlias);
    fs.chmodSync(searchOnly, 0o100);
    try {
      for (const resolve of [realpathSync, realpathSync.native]) {
        expect(resolve(file)).toBe(file);
        expect(resolve(searchOnly)).toBe(searchOnly);
      }
      if (caseInsensitive) expect(realpathSync.native(caseAlias)).toBe(file);
      expect(fs.statSync(file).mode & 0o777).toBe(0);
      expect(() => fs.readFileSync(file)).toThrowError(expect.objectContaining({ code: "EACCES" }));
      fs.chmodSync(searchOnly, 0o000);
      expect(() => realpathSync.native(file)).toThrowError(expect.objectContaining({ code: "EACCES" }));
    } finally {
      fs.chmodSync(searchOnly, 0o700);
      fs.chmodSync(file, 0o600);
    }
  });

  it("resolves a socket without opening it as a data file", async () => {
    const directory = await tempRoot("fs-rp-");
    const socket = path.join(directory, "socket");
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      expect(realpathSync.native(socket)).toBe(socket);
      expect(realpathSync(socket)).toBe(socket);
      expect(fs.lstatSync(socket).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps native error codes stable across repeated failures and successes", async () => {
    const directory = await tempRoot("fs-safe-realpath-errors-");
    const file = path.join(directory, "file");
    fs.writeFileSync(file, "x");
    fs.symlinkSync("loop", path.join(directory, "loop"));
    const cases = [
      [`${directory}/missing`, "ENOENT"],
      [`${file}/child`, "ENOTDIR"],
      [`${directory}/loop`, "ELOOP"],
    ];
    for (let round = 0; round < 100; round++) {
      for (const [input, code] of cases) {
        expect(() => realpathSync.native(input!)).toThrowError(expect.objectContaining({ code }));
        expect(realpathSync.native(file)).toBe(file);
      }
    }
    expect(() => realpathSync.native(`${directory}/file\0ignored`)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
  });
});
