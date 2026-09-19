import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

for (const operation of ["mkdir", "openWritable", "append"] as const) {
  it(`${operation} preserves the boundary replaced by a live authority callback`, async () => {
    const directory = await tempRoot("fs-safe-mkdir-authority-");
    const boundary = path.join(directory, "root");
    const saved = path.join(directory, "saved");
    const outside = path.join(directory, "outside");
    fs.mkdirSync(boundary);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(boundary, "sentinel"), "original");
    fs.writeFileSync(path.join(outside, "sentinel"), "outside");
    const scoped = await root(boundary);
    let swapped = false;
    const options = { assertBeforeMutation() {
      if (swapped) return;
      swapped = true;
      fs.renameSync(boundary, saved);
      fs.symlinkSync(outside, boundary, process.platform === "win32" ? "junction" : "dir");
    } };
    let failure: unknown;
    try {
      if (operation === "mkdir") await scoped.mkdir("child", options);
      else if (operation === "append") await scoped.append("child/file", "forbidden", options);
      else {
        const opened = await scoped.openWritable("child/file", options);
        await opened.handle.close();
      }
    } catch (error) { failure = error; }
    expect(swapped).toBe(true);
    expect(failure).toBeDefined();
    expect(fs.existsSync(path.join(outside, "child"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("outside");
    expect(fs.readFileSync(path.join(saved, "sentinel"), "utf8")).toBe("original");
  });
}
