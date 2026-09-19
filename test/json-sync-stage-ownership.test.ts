import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeJsonSync } from "../src/json.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

for (const sameBytes of [false, true]) {
  for (const failSync of [false, true]) {
    it(`preserves a substituted JSON stage (same bytes=${sameBytes}, sync failure=${failSync})`, async () => {
      const directory = await tempRoot("fs-safe-json-stage-");
      const target = path.join(directory, "state.json");
      fs.writeFileSync(target, "original destination");
      const payload = '{\n  "value": 1\n}\n';
      const foreign = sameBytes ? payload : "foreign staging bytes";
      const failure = Object.assign(new Error("synthetic sync failure"), { code: "EIO" });
      const open = fs.openSync.bind(fs);
      const sync = fs.fsyncSync.bind(fs);
      let stage = "";
      let descriptor = -1;
      let swapped = false;
      vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
        const fd = open(file, flags, mode);
        if (flags === "wx") { stage = String(file); descriptor = fd; }
        return fd;
      });
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        sync(fd);
        if (fd !== descriptor || swapped) return;
        swapped = true;
        fs.renameSync(stage, `${stage}.saved`);
        fs.writeFileSync(stage, foreign);
        if (failSync) throw failure;
      });

      expect(() => writeJsonSync(target, { value: 1 })).toThrow(
        failSync ? failure : expect.objectContaining({ code: "path-mismatch" }),
      );
      expect(swapped).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("original destination");
      expect(fs.readFileSync(stage, "utf8")).toBe(foreign);
      expect(fs.readFileSync(`${stage}.saved`, "utf8")).toBe(payload);
    });
  }
}

it.each(["EPERM", "EEXIST"])("rechecks the stage before the %s remove-and-retry fallback", async (code) => {
  const directory = await tempRoot("fs-safe-json-retry-stage-");
  const target = path.join(directory, "state.json");
  fs.writeFileSync(target, "original destination");
  const rename = fs.renameSync.bind(fs);
  let stage = "";
  vi.spyOn(fs, "renameSync").mockImplementationOnce((source) => {
    stage = String(source);
    rename(stage, `${stage}.saved`);
    fs.writeFileSync(stage, "foreign staging bytes");
    throw Object.assign(new Error("synthetic rename denial"), { code });
  });

  expect(() => writeJsonSync(target, { value: 1 })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(fs.readFileSync(target, "utf8")).toBe("original destination");
  expect(fs.readFileSync(stage, "utf8")).toBe("foreign staging bytes");
});

it("leaves a preexisting staging-name collision untouched", async () => {
  const directory = await tempRoot("fs-safe-json-stage-collision-");
  const target = path.join(directory, "state.json");
  const open = fs.openSync.bind(fs);
  let stage = "";
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    if (flags === "wx") {
      stage = String(file);
      fs.writeFileSync(stage, "foreign collision");
    }
    return open(file, flags, mode);
  });

  expect(() => writeJsonSync(target, {})).toThrow(expect.objectContaining({ code: "EEXIST" }));
  expect(fs.readFileSync(stage, "utf8")).toBe("foreign collision");
  expect(fs.existsSync(target)).toBe(false);
});
