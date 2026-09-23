import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive, prepareArchiveOutputPath } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { modeArchive, type ModeEntry } from "./helpers/archive-modes.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
  vi.unstubAllEnvs();
});

async function destination() {
  const base = await tempRoot("fs-safe-archive-literal-");
  const destDir = path.join(base, "output"), home = path.join(base, "home");
  await fs.mkdir(destDir);
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, "sentinel"), "HOME");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return { base, destDir, home };
}

async function fixture(kind: "zip" | "tar", entries: ModeEntry[]) {
  const dirs = await destination();
  const archivePath = path.join(dirs.base, `input.${kind}`);
  await fs.writeFile(archivePath, await modeArchive(kind, entries));
  return { ...dirs, archivePath };
}

async function unchangedHome(home: string) {
  expect(await fs.readdir(home)).toEqual(["sentinel"]);
  expect(await fs.readFile(path.join(home, "sentinel"), "utf8")).toBe("HOME");
}

const literalCases = [
  { label: "implicit parents", entries: [{ path: "~/nested/value" }], output: "~/nested/value", durable: false },
  { label: "explicit parent", entries: [{ path: "~/", directory: true }, { path: "~/value" }], output: "~/value", durable: false },
  { label: "empty directory", entries: [{ path: "~/", directory: true }], output: "~", directory: true, durable: true },
  { label: "bare file", entries: [{ path: "~" }], output: "~", durable: false },
  { label: "durable file", entries: [{ path: "~/value" }], output: "~/value", durable: true },
  { label: "stripped parent", entries: [{ path: "pkg/~/value" }], output: "~/value", stripComponents: 1, durable: true },
];

for (const mode of ["off", "require"] as const) {
  describe.runIf(mode === "off" || Boolean(paxNative))(`archive literal paths (${mode})`, () => {
    for (const kind of ["zip", "tar"] as const) {
      describe(kind, () => {
        function selectBackend() {
          configureFsSafeNative({ mode });
          if (mode === "require") __setNativeLoaderForTest(() => paxNative!);
        }

        it.each(literalCases)("preserves a tilde $label", async (entry) => {
          selectBackend();
          const input = await fixture(kind, entry.entries);
          const observed: string[] = [];
          await extractArchive({ ...input, kind, timeoutMs: 10_000, durable: entry.durable,
            stripComponents: entry.stripComponents, entryFilter: value => {
              observed.push(value.path); return "extract";
            } });
          expect(observed).toEqual(entry.entries.map(value => value.path.replace(/\/$/, "")));
          expect(await fs.readdir(input.destDir)).toEqual(["~"]);
          const output = path.join(input.destDir, entry.output);
          if (entry.directory) expect(await fs.readdir(output)).toEqual([]);
          else expect(await fs.readFile(output, "utf8")).toBe("NEW");
          await unchangedHome(input.home);
        });

        it.each(["~/../escape", "~\\..\\escape", "../escape", "/escape", "C:/escape"])(
          "still rejects unsafe member %s", async (member) => {
            selectBackend();
            const input = await fixture(kind, [{ path: member }]);
            await expect(extractArchive({ ...input, kind, timeoutMs: 10_000 }))
              .rejects.toMatchObject({ code: "entry-path" });
            expect(await fs.readdir(input.destDir)).toEqual([]);
            expect((await fs.readdir(input.base)).sort()).toEqual(["home", `input.${kind}`, "output"]);
            await unchangedHome(input.home);
          },
        );

        itWin32.each(["~/name:stream", "~/NUL", "~/C:escape"])("still rejects Windows alias %s", async (member) => {
          selectBackend();
          const input = await fixture(kind, [{ path: member }]);
          await expect(extractArchive({ ...input, kind, timeoutMs: 10_000 }))
            .rejects.toMatchObject({ code: "entry-path" });
          expect(await fs.readdir(input.destDir)).toEqual([]);
          await unchangedHome(input.home);
        });

        itPosix("rejects an existing tilde symlink to outside", async () => {
          selectBackend();
          const input = await fixture(kind, [{ path: "~/sentinel" }]);
          await fs.symlink(input.home, path.join(input.destDir, "~"));
          await expect(extractArchive({ ...input, kind, timeoutMs: 10_000 }))
            .rejects.toMatchObject({ code: "destination-symlink-traversal" });
          expect((await fs.lstat(path.join(input.destDir, "~"))).isSymbolicLink()).toBe(true);
          await unchangedHome(input.home);
        });
      });
    }
  });
}

it("prepares a literal tilde through the public output helper", async () => {
  configureFsSafeNative({ mode: "off" });
  const { destDir, home } = await destination();
  await prepareArchiveOutputPath({ destinationDir: destDir, destinationRealDir: destDir,
    relPath: "~", outPath: path.join(destDir, "~"), originalPath: "~/", isDirectory: true });
  expect(await fs.readdir(destDir)).toEqual(["~"]);
  await unchangedHome(home);
});

it("retains rejection of an absolute outside path in the public output helper", async () => {
  configureFsSafeNative({ mode: "off" });
  const { destDir, home } = await destination();
  await expect(prepareArchiveOutputPath({ destinationDir: destDir, destinationRealDir: destDir,
    relPath: home, outPath: home, originalPath: home, isDirectory: true }))
    .rejects.toMatchObject({
      code: process.platform === "win32" ? "invalid-path" : "destination-symlink-traversal",
    });
  expect(await fs.readdir(destDir)).toEqual([]);
  await unchangedHome(home);
});
