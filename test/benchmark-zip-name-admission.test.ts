import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerZipNameAdmission } from "../benchmarks/zip-name-admission.mjs";
import { loadZipArchiveWithPreflight } from "../src/archive-zip-preflight.js";

afterEach(() => vi.restoreAllMocks());

type Archive = Awaited<ReturnType<typeof loadZipArchiveWithPreflight>>;
type Row = {
  name: string;
  run: () => Promise<Archive>;
  options: { divisor: number; after: (archive: Archive) => Promise<void> };
};

describe("ZIP name-admission benchmark", () => {
  it("loads all 12 real archive variants and verifies output outside the public call", async () => {
    const rows: Row[] = [];
    const load = vi.fn(loadZipArchiveWithPreflight);
    await registerZipNameAdmission({
      api: { loadZipArchiveWithPreflight: load },
      register: (name: string, run: Row["run"], options: Row["options"]) =>
        rows.push({ name, run, options }),
    });
    expect(load).not.toHaveBeenCalled();
    expect(rows.map(({ name }) => name)).toEqual([
      "loadZipArchiveWithPreflight/name-admission/flagged-ascii/buffer/depth=1",
      "loadZipArchiveWithPreflight/name-admission/flagged-ascii/shared/depth=1",
      "loadZipArchiveWithPreflight/name-admission/unflagged-ascii/buffer/depth=1",
      "loadZipArchiveWithPreflight/name-admission/unflagged-ascii/shared/depth=1",
      "loadZipArchiveWithPreflight/name-admission/unicode/buffer/depth=1",
      "loadZipArchiveWithPreflight/name-admission/unicode/shared/depth=1",
      "loadZipArchiveWithPreflight/name-admission/flagged-ascii/buffer/depth=8",
      "loadZipArchiveWithPreflight/name-admission/flagged-ascii/shared/depth=8",
      "loadZipArchiveWithPreflight/name-admission/unflagged-ascii/buffer/depth=8",
      "loadZipArchiveWithPreflight/name-admission/unflagged-ascii/shared/depth=8",
      "loadZipArchiveWithPreflight/name-admission/unicode/buffer/depth=8",
      "loadZipArchiveWithPreflight/name-admission/unicode/shared/depth=8",
    ]);

    let ordinary: Buffer | undefined;
    for (const row of rows) {
      expect(row.options.divisor).toBe(100);
      const archive = await row.run();
      const bytes = load.mock.calls.at(-1)![0] as Buffer;
      const files = archive.files as Record<string, JSZip.JSZipObject>;
      const shared = row.name.includes("/shared/");
      const unicode = row.name.includes("/unicode/");
      const depth = row.name.endsWith("depth=8") ? 8 : 1;
      const flags = row.name.includes("/unflagged-ascii/") ? 0 : 0x800;
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(bytes.buffer instanceof SharedArrayBuffer).toBe(shared);
      if (shared) expect(bytes.equals(ordinary!)).toBe(true);
      else ordinary = bytes;
      const end = bytes.length - 22;
      const central = bytes.readUInt32LE(end + 16);
      expect(bytes.readUInt16LE(6)).toBe(flags);
      expect(bytes.readUInt16LE(central + 8)).toBe(flags);
      expect(bytes.readUInt16LE(end + 8)).toBe(2048);
      expect(bytes.readUInt16LE(end + 10)).toBe(2048);
      const names = Object.keys(files);
      expect(names).toHaveLength(2048);
      expect(names.every(name => name.split("/").length === depth)).toBe(true);
      expect(names.every(name => /[^\x00-\x7f]/u.test(name) === unicode)).toBe(true);
      expect(names.every(name => files[name]!.dir === false)).toBe(true);
      for (const index of [0, 1024, 2047]) {
        expect(names[index]!.split("/").at(-1))
          .toBe(`${unicode ? "entrée" : "entry"}-${String(index).padStart(4, "0")}.txt`);
        expect(await files[names[index]!]!.async("string"))
          .toBe(`payload-${String(index).padStart(4, "0")}`.padEnd(64, "."));
      }
      await row.options.after(archive);
      files[names[1500]!]!.dir = true;
      await expect(row.options.after(archive)).rejects.toThrow();
      files[names[1500]!]!.dir = false;
    }
    const repeated = await rows[1]!.run();
    expect(load.mock.calls.at(-1)![0]).toBe(load.mock.calls[1]![0]);
    await rows[1]!.options.after(repeated);
  }, 30_000);

  it("rejects a fixture with incorrect flags in its last local record before registration", async () => {
    const generate = JSZip.prototype.generateAsync;
    vi.spyOn(JSZip.prototype, "generateAsync").mockImplementation(async function (this: JSZip, ...args) {
      const bytes = await Reflect.apply(generate, this, args) as Buffer;
      let central = bytes.readUInt32LE(bytes.length - 6);
      let lastLocal = 0;
      for (let index = 0; index < 2048; index++) {
        lastLocal = bytes.readUInt32LE(central + 42);
        central += 46 + bytes.readUInt16LE(central + 28) +
          bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32);
      }
      bytes.writeUInt16LE(0, lastLocal + 6);
      return bytes;
    });
    const register = vi.fn();
    const load = vi.fn();
    await expect(registerZipNameAdmission({
      api: { loadZipArchiveWithPreflight: load }, register,
    })).rejects.toThrow();
    expect(register).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  }, 30_000);
});
