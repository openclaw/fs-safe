import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxArchive } from "./helpers/archive-pax.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const invalid = { code: "archive-header-invalid", message: expect.stringContaining("unsupported or malformed PAX metadata") };

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.skipIf(mode === "require" && !paxNative)(`canonical PAX decimal mode=${mode}`, () => {
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
    });

    async function setup(bytes: Buffer) {
      const root = await tempRoot("fs-safe-pax-decimal-");
      const archivePath = path.join(root, "fixture.tar");
      const destDir = path.join(root, "out");
      await fs.writeFile(archivePath, bytes);
      await fs.mkdir(destDir);
      return { archivePath, destDir };
    }

    async function reject(bytes: Buffer) {
      const fixture = await setup(bytes);
      await expect(extractArchive(fixture)).rejects.toMatchObject(invalid);
      expect(await fs.readdir(fixture.destDir)).toEqual([]);
      await expect(readArchiveEntry(fixture.archivePath, "raw", { maxBytes: 7 })).rejects.toMatchObject(invalid);
    }

    it.each(["0", "1", "999999999999999", "1000000000000000", "9007199254740990", "9007199254740991"])(
      "accepts canonical uid/gid %s without changing member data",
      async (value) => {
        const fixture = await setup(paxArchive([["uid", value], ["gid", value], ["size", "7"]]));
        await extractArchive(fixture);
        expect(await fs.readFile(path.join(fixture.destDir, "raw"), "utf8")).toBe("payload");
        expect(await fs.readFile(path.join(fixture.destDir, "sentinel"), "utf8")).toBe("end");
        expect(await readArchiveEntry(fixture.archivePath, "raw", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
      },
    );

    it.each([
      ["empty", Buffer.from("")], ["leading zero", Buffer.from("01")],
      ["plus", Buffer.from("+1")], ["minus", Buffer.from("-1")],
      ["leading whitespace", Buffer.from(" 1")], ["trailing whitespace", Buffer.from("1\n")],
      ["NUL", Buffer.from("1\0")], ["invalid UTF-8", Buffer.from([0x31, 0xff])],
      ["truncated UTF-8", Buffer.from([0x31, 0xc3])], ["Unicode digit", Buffer.from("1١")],
      ["separator", Buffer.from("1_000")], ["MAX plus one", Buffer.from("9007199254740992")],
      ["sixteen digits over MAX", Buffer.from("9999999999999999")],
      ["seventeen digits", Buffer.from("10000000000000000")],
      ["sixteen-byte invalid suffix", Buffer.from("123456789012345x")],
      ["seventeen-byte invalid suffix", Buffer.from("1234567890123456x")],
    ] as const)("rejects %s in an ownership number", async (_label, value) => {
      await reject(paxArchive([["uid", value], ["gid", "0"]]));
    });

    it("accepts a canonical record length and applies its path override", async () => {
      const body = Buffer.from("10 path=a\n");
      expect(body.length).toBe(10);
      const fixture = await setup(tarFixture([
        { path: "PaxHeader", type: "x", body },
        { path: "raw", body: "payload" },
      ]));
      await extractArchive(fixture);
      expect(await fs.readdir(fixture.destDir)).toEqual(["a"]);
      expect(await fs.readFile(path.join(fixture.destDir, "a"), "utf8")).toBe("payload");
      expect(await readArchiveEntry(fixture.archivePath, "a", { maxBytes: 7 })).toEqual(Buffer.from("payload"));
    });

    it.each([
      ["plus", Buffer.from("+11")], ["leading zero", Buffer.from("011")],
      ["invalid UTF-8", Buffer.from([0x39, 0xff])],
      ["seventeen bytes", Buffer.from("10000000000000000")],
    ] as const)("rejects %s in a record length", async (_label, prefix) => {
      await reject(tarFixture([
        { path: "PaxHeader", type: "x", body: Buffer.concat([prefix, Buffer.from(" path=a\n")]) },
        { path: "raw", body: "payload" },
      ]));
    });
  });
}
