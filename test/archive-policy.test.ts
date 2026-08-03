import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";

const { tempRoot } = useTempDirs();

beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
});


afterEach(async () => {
  __resetFsSafeNativeConfigForTest();
});

describe("archive entry policy", () => {
  itPosix("clamps ZIP modes by default and preserves safe permission bits on request", async () => {
    const root = await tempRoot("fs-safe-archive-policy-");
    const archivePath = path.join(root, "package.zip");
    const zip = new JSZip();
    zip.file("plain.txt", "plain", { unixPermissions: 0o10670 });
    zip.file("tool", "exec", { unixPermissions: 0o10711 });
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));

    const clamped = path.join(root, "clamped");
    await fs.mkdir(clamped);
    await extractArchive({ archivePath, destDir: clamped, timeoutMs: 10_000 });
    expect((await fs.stat(path.join(clamped, "plain.txt"))).mode & 0o7777).toBe(0o644);
    expect((await fs.stat(path.join(clamped, "tool"))).mode & 0o7777).toBe(0o755);

    const preserved = path.join(root, "preserved");
    await fs.mkdir(preserved);
    await extractArchive({
      archivePath,
      destDir: preserved,
      timeoutMs: 10_000,
      entryModes: "preserve",
    });
    expect((await fs.stat(path.join(preserved, "plain.txt"))).mode & 0o7777).toBe(0o670);
    expect((await fs.stat(path.join(preserved, "tool"))).mode & 0o7777).toBe(0o711);
  });

  it("rejects filtered archives by default and can explicitly skip entries", async () => {
    const root = await tempRoot("fs-safe-archive-filter-");
    const archivePath = path.join(root, "package.zip");
    const zip = new JSZip();
    zip.file("keep.txt", "keep");
    zip.file("skip.txt", "skip");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    const rejected = path.join(root, "rejected");
    await fs.mkdir(rejected);
    const filter = ({ path: entryPath }: { path: string }) =>
      entryPath === "skip.txt" ? ("skip" as const) : ("extract" as const);

    await expect(
      extractArchive({ archivePath, destDir: rejected, timeoutMs: 10_000, entryFilter: filter }),
    ).rejects.toThrow("archive entry rejected by filter");
    await expect(fs.readdir(rejected)).resolves.toEqual([]);

    const skipped = path.join(root, "skipped");
    await fs.mkdir(skipped);
    await extractArchive({
      archivePath,
      destDir: skipped,
      timeoutMs: 10_000,
      entryFilter: filter,
      onFiltered: "skip-entry",
    });
    await expect(fs.readFile(path.join(skipped, "keep.txt"), "utf8")).resolves.toBe("keep");
    await expect(fs.access(path.join(skipped, "skip.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("applies TAR mode and filtering policy in staging", async () => {
    const root = await tempRoot("fs-safe-tar-policy-");
    const input = path.join(root, "input");
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, "tool"), "tool");
    await fs.writeFile(path.join(input, "skip"), "skip");
    await fs.chmod(path.join(input, "tool"), 0o710);
    const archivePath = path.join(root, "package.tar");
    await tar.c({ cwd: input, file: archivePath }, ["tool", "skip"]);
    const destination = path.join(root, "destination");
    await fs.mkdir(destination);
    await extractArchive({
      archivePath,
      destDir: destination,
      timeoutMs: 10_000,
      entryFilter: (entry) => (entry.path === "skip" ? "skip" : "extract"),
      onFiltered: "skip-entry",
    });
    expect((await fs.stat(path.join(destination, "tool"))).mode & 0o7777).toBe(0o755);
    await expect(fs.access(path.join(destination, "skip"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads bounded ZIP and TAR entries without materializing a destination", async () => {
    const root = await tempRoot("fs-safe-archive-read-");
    const zipPath = path.join(root, "package.zip");
    const zip = new JSZip();
    zip.file("nested/value.txt", "value");
    await fs.writeFile(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(readArchiveEntry(zipPath, "nested/value.txt", { maxBytes: 5 })).resolves.toEqual(Buffer.from("value"));
    await expect(readArchiveEntry(zipPath, "nested/value.txt", { maxBytes: 4 })).rejects.toMatchObject({
      code: "archive-entry-extracted-size-exceeds-limit",
    });

    const input = path.join(root, "input");
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, "value.txt"), "tar-value");
    const tarPath = path.join(root, "package.tar");
    await tar.c({ cwd: input, file: tarPath }, ["value.txt"]);
    await expect(readArchiveEntry(tarPath, "value.txt", { maxBytes: 9 })).resolves.toEqual(Buffer.from("tar-value"));
  });
});
