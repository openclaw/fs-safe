import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { extractArchive } from "../src/archive.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { modeArchive, removeModeFixture } from "./helpers/archive-modes.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
async function fixture() {
  configureFsSafeNative({ mode: "off" });
  const base = await tempRoot("fs-safe-durability-pass-");
  const destDir = path.join(base, "output");
  await fs.mkdir(destDir);
  const archivePath = path.join(base, "input.tar");
  await fs.writeFile(archivePath, await modeArchive("tar", Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, mode: 0o644 }))));
  const probe = await fs.open(path.join(base, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  return { options: { archivePath, destDir, kind: "tar" as const, timeoutMs: 10000 }, prototype };
}

it.each(["file", "directory"])("propagates %s sync failure", async (kind) => {
  const { options, prototype } = await fixture();
  const sync = prototype.sync;
  let failed = false;
  vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    if (fsSync.fstatSync(this.fd).isFile() === (kind === "file")) {
      failed = true;
      throw Object.assign(new Error("injected sync failure"), { code: "EIO" });
    }
    await sync.call(this);
  });
  await expect(extractArchive(options)).rejects.toMatchObject({ code: "invalid-path", cause: { code: "EIO" } });
  expect(failed).toBe(true);
});

it("bounds file syncs at eight and joins them on timeout before rejecting", async () => {
  const { options, prototype } = await fixture();
  const entered = deferred();
  const release = deferred();
  const sync = prototype.sync;
  let active = 0;
  let started = 0;
  let peak = 0;
  let settled = false;
  vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    if (!fsSync.fstatSync(this.fd).isFile()) return await sync.call(this);
    started++;
    peak = Math.max(peak, ++active);
    if (active === 8) entered.resolve();
    await release.promise;
    try { await sync.call(this); } finally { active--; }
  });
  const extraction = extractArchive({ ...options, timeoutMs: 1000 });
  void extraction.then(() => { settled = true; }, () => { settled = true; });
  try {
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(settled).toBe(false);
    expect(peak).toBe(8);
  } finally { release.resolve(); }
  await expect(extraction).rejects.toThrow("timed out");
  expect(active).toBe(0);
  expect(started).toBe(8);
}, 10000);

it.each([true, false])("keeps restrictive file and directory modes with durable %s", async (durable) => {
  const { options } = await fixture();
  await fs.writeFile(options.archivePath, await modeArchive("tar", [
    { path: "closed/", directory: true, mode: 0 },
    { path: "closed/write-only", mode: 0o200 },
    { path: "closed/unreadable", mode: 0 },
    { path: "closed/read-only", mode: 0o400 },
  ]));
  try {
    await extractArchive({ ...options, entryModes: "preserve", durable });
    if (process.platform !== "win32") expect((await fs.stat(path.join(options.destDir, "closed"))).mode & 0o777).toBe(0);
    await fs.chmod(path.join(options.destDir, "closed"), 0o700);
    for (const [name, mode] of [["write-only", 0o200], ["unreadable", 0], ["read-only", 0o400]] as const) {
      const target = path.join(options.destDir, "closed", name);
      if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(mode);
      await fs.chmod(target, 0o600);
      expect(await fs.readFile(target, "utf8")).toBe("NEW");
    }
  } finally { await removeModeFixture(options.destDir); }
});
