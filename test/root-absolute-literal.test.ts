import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root as openRoot } from "../src/index.js";
import { itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.unstubAllEnvs();
  configureFsSafeNative({ mode: "auto" });
});

async function fixture() {
  const container = await tempRoot("fs-safe-absolute-literal-");
  const canonical = path.join(container, "root");
  const configured = path.join(container, "alias");
  const inside = path.join(canonical, "home");
  const outside = path.join(container, "outside");
  await fs.mkdir(inside, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(inside, "entry"), "home inside");
  await fs.writeFile(path.join(outside, "entry"), "home outside");
  await fs.symlink(canonical, configured, process.platform === "win32" ? "junction" : "dir");
  return { container, canonical, configured, inside, outside };
}

describe.each(["inside", "outside"] as const)("absolute literals with HOME %s the Root", home => {
  it.each([false, true])("preserves literal tilde paths with configured alias=%s", async alias => {
    const { canonical, configured, inside, outside } = await fixture();
    vi.stubEnv("HOME", home === "inside" ? inside : outside);
    const safe = await openRoot(alias ? configured : canonical);
    const names = ["~/entry", "~other/entry", "nested/~/entry", "nested~/entry"];
    for (const name of names) {
      const file = path.join(canonical, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, name);
      for (const prefix of alias ? [canonical, configured] : [canonical]) {
        const absolute = path.join(prefix, name);
        await expect(safe.readAbsolute(absolute)).resolves.toMatchObject({ buffer: Buffer.from(name) });
        await expect(safe.reader()(absolute)).resolves.toEqual(Buffer.from(name));
      }
      await expect(safe.readText(file)).resolves.toBe(name);
    }
    await expect(safe.readText("./~/entry")).resolves.toBe("~/entry");
    for (const read of [() => safe.readText("~/entry"), () => safe.readAbsolute("~/entry"), () => safe.reader()("~/entry")]) {
      if (home === "inside") {
        const result = await read();
        expect(typeof result === "string" ? result : Buffer.isBuffer(result) ? result.toString() : result.buffer.toString()).toBe("home inside");
      } else {
        await expect(read()).rejects.toMatchObject({ code: "outside-workspace" });
      }
    }
  });

  it("preserves a file named exactly tilde through both admitted absolute spellings", async () => {
    const { canonical, configured, inside, outside } = await fixture();
    vi.stubEnv("HOME", home === "inside" ? inside : outside);
    await fs.writeFile(path.join(canonical, "~"), "literal file");
    const safe = await openRoot(configured);
    for (const prefix of [canonical, configured]) {
      await expect(safe.readAbsolute(path.join(prefix, "~"))).resolves.toMatchObject({ buffer: Buffer.from("literal file") });
      await expect(safe.reader()(path.join(prefix, "~"))).resolves.toEqual(Buffer.from("literal file"));
    }
  });
});

it("keeps an admitted empty absolute tail a directory read", async () => {
  const { canonical, configured, inside } = await fixture();
  vi.stubEnv("HOME", inside);
  const safe = await openRoot(configured);
  for (const prefix of [canonical, configured]) {
    await expect(safe.readAbsolute(`${prefix}${path.sep}`)).rejects.toMatchObject({ code: "not-file" });
    await expect(safe.reader()(`${prefix}${path.sep}`)).rejects.toMatchObject({ code: "not-file" });
  }
});

it("preserves raw parent traversal and symlink policy after absolute admission", async () => {
  const { canonical, configured, inside, outside } = await fixture();
  vi.stubEnv("HOME", inside);
  for (const parent of [canonical, path.join(canonical, "nested")]) {
    await fs.mkdir(path.join(parent, "~"), { recursive: true });
    await fs.writeFile(path.join(parent, "~", "entry"), parent === canonical ? "lexical" : "canonical target");
  }
  const target = path.join(canonical, "nested", "child");
  await fs.mkdir(target);
  await fs.symlink(target, path.join(canonical, "link"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(outside, path.join(canonical, "escape"), process.platform === "win32" ? "junction" : "dir");
  const safe = await openRoot(configured);
  const follow = { symlinks: "follow-within-root" as const };
  for (const prefix of [canonical, configured]) {
    const raw = `${prefix}${path.sep}link${path.sep}..${path.sep}~${path.sep}entry`;
    await expect(safe.readAbsolute(raw)).rejects.toMatchObject({ code: "symlink" });
    await expect(safe.reader()(raw)).rejects.toMatchObject({ code: "symlink" });
    await expect(safe.readAbsolute(raw, follow)).resolves.toMatchObject({ buffer: Buffer.from("canonical target") });
    await expect(safe.reader(follow)(raw)).resolves.toEqual(Buffer.from("canonical target"));
    await expect(safe.readAbsolute(`${prefix}${path.sep}..${path.sep}outside${path.sep}entry`)).rejects.toMatchObject({ code: "outside-workspace" });
    await expect(safe.reader(follow)(`${prefix}${path.sep}escape${path.sep}entry`)).rejects.toMatchObject({ code: "outside-workspace" });
  }
  await expect(safe.readAbsolute(path.join(outside, "entry"))).rejects.toMatchObject({ code: "outside-workspace" });
});

itWin32("keeps admitted Windows tails literal with either separator spelling", async () => {
  const { canonical, configured, inside } = await fixture();
  vi.stubEnv("HOME", inside);
  await fs.mkdir(path.join(canonical, "~"));
  await fs.writeFile(path.join(canonical, "~", "entry"), "literal Windows entry");
  const safe = await openRoot(configured);
  for (const prefix of [canonical, configured]) {
    const native = path.join(prefix, "~", "entry");
    for (const absolute of [native, native.replaceAll("\\", "/")]) {
      await expect(safe.readAbsolute(absolute)).resolves.toMatchObject({ buffer: Buffer.from("literal Windows entry") });
      await expect(safe.reader()(absolute)).resolves.toEqual(Buffer.from("literal Windows entry"));
    }
  }
});
