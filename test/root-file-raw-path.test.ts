import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { openRootFile, openRootFileSync } from "../src/root-file.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it.each(["async", "sync"].flatMap(mode => [false, true].map(rejectSymlinks => ({ mode, rejectSymlinks }))))(
  "$mode retains symlink/parent traversal before opening (reject=$rejectSymlinks)",
  async ({ mode, rejectSymlinks }) => {
    const dir = await tempRoot("fs-safe-root-file-raw-");
    await fs.mkdir(path.join(dir, "deep", "dir"), { recursive: true });
    await fs.writeFile(path.join(dir, "value"), "lexical bytes");
    await fs.writeFile(path.join(dir, "deep", "value"), "canonical bytes");
    await fs.symlink(path.join(dir, "deep", "dir"), path.join(dir, "link"),
      process.platform === "win32" ? "junction" : "dir");
    const params = {
      absolutePath: `${dir}${path.sep}link${path.sep}..${path.sep}value`,
      rootPath: dir, boundaryLabel: "fixture", rejectSymlinks,
    };
    const opened = mode === "async" ? await openRootFile(params) : openRootFileSync(params);
    if (rejectSymlinks) {
      if (opened.ok) fsSync.closeSync(opened.fd);
      expect(opened).toMatchObject({ ok: false, reason: "validation", error: { code: "symlink" } });
    } else {
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw opened.error;
      try { expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("canonical bytes"); }
      finally { fsSync.closeSync(opened.fd); }
    }
  },
);

it.runIf(process.platform === "win32").each(["async", "sync"])(
  "%s preserves drive-relative inputs",
  async mode => {
    const dir = await tempRoot("fs-safe-root-file-drive-");
    const target = path.join(dir, "value");
    await fs.writeFile(target, "drive-relative bytes");
    const drive = path.parse(target).root.slice(0, 2);
    const driveRelative = `${drive}${path.relative(path.resolve(drive), target)}`;
    const params = { rootPath: dir, absolutePath: driveRelative, boundaryLabel: "fixture" };
    const opened = mode === "async" ? await openRootFile(params) : openRootFileSync(params);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw opened.error;
    try { expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("drive-relative bytes"); }
    finally { fsSync.closeSync(opened.fd); }
  },
);
