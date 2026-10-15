import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyRootFileSync } from "../src/advanced.js";
import { configureFsSafeNative, root } from "../src/index.js";
import { probeTreeClone } from "../src/copy.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { loadTestNative } from "./helpers/native-probe.js";

const fixtureRoot = process.env.FS_SAFE_CLONE_TEST_ROOT;
const directories: string[] = [];
afterEach(() => {
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

function nocow(file: string): boolean {
  return execFileSync("lsattr", ["-d", "--", file], { encoding: "utf8" }).split(/\s/)[0]!.includes("C");
}

describe.skipIf(process.platform !== "linux" || !fixtureRoot)("Btrfs file clone policy", () => {
  for (const sourceNocow of [false, true]) {
    for (const api of ["sync", "root"] as const) {
      it.each(["auto", "always", "never"] as const)(
        `${api} copy with source NOCOW=${sourceNocow}, clone=%s`,
        async clone => {
          configureFsSafeNative({ mode: "require" });
          const native = loadTestNative("required-env")!;
          expect(native.copyFileExclusive).toBeTypeOf("function");
          const methods: string[] = [];
          __setNativeLoaderForTest(() => ({
            ...native,
            async copyFileExclusive(...args) {
              const result = await native.copyFileExclusive!(...args);
              methods.push(result.method);
              return result;
            },
          }));
          expect(probeTreeClone(fixtureRoot!)).toBe("btrfs");
          const directory = fs.mkdtempSync(path.join(fixtureRoot!, "file-clone-"));
          directories.push(directory);
          const sourceRoot = path.join(directory, "source");
          const targetRoot = path.join(directory, "destination");
          fs.mkdirSync(sourceRoot, { mode: 0o700 });
          fs.mkdirSync(targetRoot, { mode: 0o700 });
          execFileSync("chattr", [sourceNocow ? "-C" : "+C", "--", targetRoot]);
          const source = path.join(sourceRoot, "input");
          const target = path.join(targetRoot, "output");
          fs.writeFileSync(source, "");
          execFileSync("chattr", [sourceNocow ? "+C" : "-C", "--", source]);
          const payload = Buffer.alloc(32 * 1024 * 1024, 0x5a);
          fs.writeFileSync(source, payload);
          const before = fs.statSync(source, { bigint: true });
          if (api === "sync") {
            using copied = copyRootFileSync({
              source: { rootPath: sourceRoot, absolutePath: source },
              destination: { rootPath: targetRoot, absolutePath: target },
              clone,
            });
            methods.push(copied.method);
          } else {
            await (await root(targetRoot)).copyIn("output", source, { clone });
          }
          expect(methods).toEqual([clone === "never" ? "copy" : "clone"]);
          expect(nocow(target)).toBe(clone === "never" ? !sourceNocow : sourceNocow);
          expect(nocow(source)).toBe(sourceNocow);
          expect(nocow(targetRoot)).toBe(!sourceNocow);
          const after = fs.statSync(source, { bigint: true });
          const copied = fs.statSync(target, { bigint: true });
          expect([after.dev, after.ino, after.size]).toEqual([before.dev, before.ino, before.size]);
          expect([copied.dev, copied.ino]).not.toEqual([before.dev, before.ino]);
          expect(fs.readFileSync(target).equals(payload)).toBe(true);
          const fd = fs.openSync(target, "r+");
          try { fs.writeSync(fd, Buffer.from("x"), 0, 1, 0); } finally { fs.closeSync(fd); }
          expect(fs.readFileSync(source).equals(payload)).toBe(true);
        },
      );
    }
  }
});
